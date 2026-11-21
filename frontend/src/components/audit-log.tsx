'use client';
/**
 * Admin: the audit trail (ADR-0005). Access records (every request through the gateway),
 * newest first, and for one request the Change records it caused in every service.
 */
import { useState } from 'react';
import { Badge, DateTime, Empty, ErrorBox, Field, Loaded, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { AccessPage, AccessRecordView, ChangesResponse } from '@/lib/types';

const SERVICE_LABEL: Record<string, string> = {
  identity: 'Tài khoản',
  student: 'Học sinh',
  class: 'Lớp học',
  schedule: 'Lịch học',
  billing: 'Học phí',
  audit: 'Nhật ký',
};

const statusTone = (s: number) => (s >= 500 || s === 0 ? 'red' : s >= 400 ? 'amber' : 'green');
const show = (v: unknown) =>
  v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

interface Filters {
  userId: string;
  correlationId: string;
  method: string;
  status: string;
}
const EMPTY: Filters = { userId: '', correlationId: '', method: '', status: '' };

const fetchPage = (filters: Filters, cursor?: string) =>
  api.get<AccessPage>('/audit/access', { ...filters, limit: 50, cursor });

export function AuditLog() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value.trim() }));

  return (
    <>
      <h1>Nhật ký hệ thống</h1>
      <p className="hint">
        Mỗi request qua API Gateway là một dòng, kể cả request bị từ chối. Không ghi nội dung
        request, token hay giá trị tham số. Bấm một request để xem các thay đổi dữ liệu nó gây ra.
      </p>
      <form
        className="grid"
        aria-label="Lọc nhật ký"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <Field label="Mã người dùng">
          <input value={draft.userId} onChange={set('userId')} />
        </Field>
        <Field label="Correlation id">
          <input value={draft.correlationId} onChange={set('correlationId')} />
        </Field>
        <Field label="Method">
          <select value={draft.method} onChange={set('method')}>
            <option value="">Tất cả</option>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Mã trạng thái">
          <input inputMode="numeric" value={draft.status} onChange={set('status')} />
        </Field>
        <div className="row end">
          <button className="btn" type="submit">
            Lọc
          </button>
        </div>
      </form>
      {/* A new filter mounts a fresh list: first page again, nothing opened. */}
      <AccessList key={JSON.stringify(filters)} filters={filters} />
    </>
  );
}

function AccessList({ filters }: { filters: Filters }) {
  const first = useLoad(() => fetchPage(filters));
  const [more, setMore] = useState<AccessRecordView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [opened, setOpened] = useState<string | null>(null);

  return (
    <Loaded state={first}>
      {(page) => {
        const items = [...page.items, ...more];
        const next = cursor === undefined ? page.nextCursor : cursor;
        return items.length === 0 ? (
          <Empty>Không có bản ghi nào.</Empty>
        ) : (
          <>
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Thời điểm</th>
                    <th>Người dùng</th>
                    <th>Request</th>
                    <th>Trạng thái</th>
                    <th>Service</th>
                    <th>ms</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <AccessRow
                      key={r.id}
                      record={r}
                      open={opened === r.id}
                      onToggle={() => setOpened(opened === r.id ? null : r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <ErrorBox error={error} />
            {loadingMore && <Loading />}
            {next && !loadingMore && (
              <div className="row end">
                <button
                  className="btn secondary"
                  onClick={async () => {
                    setLoadingMore(true);
                    setError(null);
                    try {
                      const nextPage = await fetchPage(filters, next);
                      setMore((m) => [...m, ...nextPage.items]);
                      setCursor(nextPage.nextCursor);
                    } catch (err) {
                      setError(err);
                    } finally {
                      setLoadingMore(false);
                    }
                  }}
                >
                  Tải thêm
                </button>
              </div>
            )}
          </>
        );
      }}
    </Loaded>
  );
}

function AccessRow({
  record: r,
  open,
  onToggle,
}: {
  record: AccessRecordView;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <DateTime value={r.occurredAt} />
        </td>
        <td>
          {r.userId ? (
            <>
              <code>{r.userId.slice(0, 8)}</code> {r.role}
            </>
          ) : (
            <span className="muted">chưa đăng nhập</span>
          )}
          <div className="muted">{r.ip}</div>
        </td>
        <td>
          <button className="link" onClick={onToggle} aria-expanded={open}>
            {r.method} {r.path}
            {r.queryKeys.length > 0 && `?${r.queryKeys.join('&')}`}
          </button>
        </td>
        <td>
          <Badge tone={statusTone(r.status)}>{r.status || 'hủy'}</Badge>
        </td>
        <td>{r.service ? (SERVICE_LABEL[r.service] ?? r.service) : 'Gateway'}</td>
        <td>{Math.round(r.durationMs)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <Changes correlationId={r.correlationId} />
          </td>
        </tr>
      )}
    </>
  );
}

function Changes({ correlationId }: { correlationId: string }) {
  const state = useLoad(() => api.get<ChangesResponse>('/audit/changes', { correlationId }));
  return (
    <Loaded state={state}>
      {(data) => (
        <section aria-label="Thay đổi dữ liệu" className="stack">
          {data.unavailable.length > 0 && (
            <p className="alert warning">
              Chưa đọc được từ: {data.unavailable.map((s) => SERVICE_LABEL[s] ?? s).join(', ')}.
            </p>
          )}
          {data.records.length === 0 ? (
            <Empty>Request này không thay đổi dữ liệu.</Empty>
          ) : (
            data.records.map((c) => (
              <div key={c.id}>
                <strong>{c.action}</strong> · {SERVICE_LABEL[c.service] ?? c.service} ·{' '}
                {c.entityType} <code>{c.entityId.slice(0, 8)}</code> · {c.actorRole}
                <table>
                  <tbody>
                    {Object.entries(c.changes).map(([field, ch]) => (
                      <tr key={field}>
                        <td>{field}</td>
                        <td>{show(ch.from)}</td>
                        <td>→</td>
                        <td>{show(ch.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </section>
      )}
    </Loaded>
  );
}
