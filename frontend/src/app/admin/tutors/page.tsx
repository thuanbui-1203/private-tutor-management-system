'use client';
/** Admin: Tutor profiles waiting for a decision, and the review of one (docs/07 §2). */
import { useState } from 'react';
import {
  ActionButton,
  Badge,
  DateTime,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { api, describeError, downloadFile } from '@/lib/api';
import { formatDate, formatMoney, WEEKDAY_LABEL } from '@/lib/format';
import {
  areaLabel,
  CREDENTIAL_LABEL,
  DECISION_LABEL,
  gradesLabel,
  ITEM_STATUS,
  KIND_LABEL,
  PROFILE_STATUS,
  type ProfileStatus,
  type TutorProfileView,
  type TutorSummary,
} from '@/lib/tutors';

const FILTERS: [string, string][] = [
  ['waiting', 'Chờ duyệt'],
  ['VERIFIED', 'Đã xác minh'],
  ['NEEDS_CHANGES', 'Cần bổ sung'],
  ['SUSPENDED', 'Tạm khóa'],
  ['REJECTED', 'Bị từ chối'],
  ['DRAFT', 'Đang soạn'],
];

export default function TutorReviewPage() {
  const [filter, setFilter] = useState('waiting');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useLoad(
    () =>
      api.get<TutorSummary[]>(
        '/tutors',
        filter === 'waiting' ? { waiting: 'true' } : { status: filter },
      ),
    [filter],
  );
  return (
    <>
      <h1>Duyệt hồ sơ gia sư</h1>
      <Field label="Hiển thị">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 240 }}
        >
          {FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Loaded state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Không có hồ sơ nào.</Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Gia sư</th>
                    <th>Loại</th>
                    <th>Trạng thái</th>
                    <th>Gửi lúc</th>
                    <th className="num">Mục chờ duyệt</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.tutorId}>
                      <td>{r.displayName ?? '(chưa đặt tên)'}</td>
                      <td>{r.kind ? KIND_LABEL[r.kind] : '—'}</td>
                      <td>
                        <Badge tone={PROFILE_STATUS[r.status][1]}>
                          {PROFILE_STATUS[r.status][0]}
                        </Badge>
                      </td>
                      <td>
                        <DateTime value={r.submittedAt} />
                      </td>
                      <td className="num">{r.pendingCredentials + r.pendingSubjects}</td>
                      <td>
                        <button
                          className="btn secondary small"
                          aria-expanded={openId === r.tutorId}
                          onClick={() => setOpenId(openId === r.tutorId ? null : r.tutorId)}
                        >
                          {openId === r.tutorId ? 'Đóng' : 'Xem hồ sơ'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
      {openId && <Review key={openId} tutorId={openId} onDecided={() => list.reload()} />}
    </>
  );
}

const DECISIONS_FOR: Record<ProfileStatus, string[]> = {
  DRAFT: [],
  SUBMITTED: ['VERIFY', 'NEEDS_CHANGES', 'REJECT'],
  NEEDS_CHANGES: [],
  VERIFIED: ['VERIFY', 'NEEDS_CHANGES', 'SUSPEND'],
  REJECTED: [],
  SUSPENDED: ['REINSTATE'],
};

function Review({ tutorId, onDecided }: { tutorId: string; onDecided: () => void }) {
  const state = useLoad(() => api.get<TutorProfileView>(`/tutors/${tutorId}`), [tutorId]);
  const [items, setItems] = useState<Record<string, { status: string; note: string }>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const pick = (id: string, patch: Partial<{ status: string; note: string }>) =>
    setItems((m) => ({
      ...m,
      [id]: { status: m[id]?.status ?? '', note: m[id]?.note ?? '', ...patch },
    }));

  async function decide(p: TutorProfileView, decision: string) {
    setError('');
    setDone('');
    const chosen = (ids: { id: string }[]) =>
      ids
        .filter((x) => items[x.id]?.status)
        .map((x) => ({ id: x.id, status: items[x.id].status, note: items[x.id].note || null }));
    try {
      const { data } = await api.post<TutorProfileView>(`/tutors/${tutorId}/review`, {
        decision,
        reason: reason.trim() || null,
        credentials: chosen(p.credentials),
        subjects: chosen(p.subjects),
      });
      state.setData(data);
      setItems({});
      setReason('');
      setDone(`Đã ${DECISION_LABEL[decision].toLowerCase()}.`);
      onDecided();
    } catch (err) {
      setError(describeError(err));
    }
  }

  // A function, not a component: a component declared here would remount and lose focus.
  const itemDecision = (id: string, status: string) =>
    status === 'PENDING' || items[id] ? (
      <span className="row">
        <select
          aria-label="Quyết định"
          value={items[id]?.status ?? ''}
          onChange={(e) => pick(id, { status: e.target.value })}
        >
          <option value="">Chưa quyết</option>
          <option value="VERIFIED">Đạt</option>
          <option value="REJECTED">Không đạt</option>
        </select>
        <input
          aria-label="Ghi chú"
          placeholder="Ghi chú cho gia sư"
          value={items[id]?.note ?? ''}
          onChange={(e) => pick(id, { note: e.target.value })}
        />
      </span>
    ) : null;

  return (
    <section className="card" style={{ marginTop: '1rem' }} aria-label="Hồ sơ gia sư">
      <Loaded state={state}>
        {(p) => (
          <>
            <h2 style={{ marginTop: 0 }}>
              {p.displayName ?? '(chưa đặt tên)'}{' '}
              <Badge tone={PROFILE_STATUS[p.status][1]}>{PROFILE_STATUS[p.status][0]}</Badge>
            </h2>
            <p>
              {p.kind ? KIND_LABEL[p.kind] : '—'} · {p.school ?? '—'} ({p.schoolCountry ?? '—'})
              {p.gpa !== null && ` · GPA ${p.gpa}/${p.gpaScale}`}
            </p>
            {p.kind === 'TEACHER' && (
              <p className="hint">
                Đã báo Hiệu trưởng: {p.reportedToPrincipal ? 'có' : 'chưa'}; không dạy học sinh của
                mình: {p.noOwnPupils ? 'có' : 'chưa'}.
              </p>
            )}
            {p.bio && <p>{p.bio}</p>}

            <h3>Minh chứng</h3>
            {p.credentials.length === 0 && <Empty>Không có.</Empty>}
            <ul className="stack">
              {p.credentials.map((c) => (
                <li key={c.id}>
                  <b>{CREDENTIAL_LABEL[c.kind]}</b>: {c.title}, {c.issuer} ({c.country})
                  {c.number && `, số ${c.number}`}
                  {c.issuedOn && `, cấp ${formatDate(c.issuedOn)}`}
                  {c.expiresOn && `, hết hạn ${formatDate(c.expiresOn)}`}{' '}
                  <Badge tone={ITEM_STATUS[c.status][1]}>{ITEM_STATUS[c.status][0]}</Badge>{' '}
                  {c.file && (
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() =>
                        downloadFile(
                          `/tutors/${tutorId}/credentials/${c.id}/file`,
                          c.file!.name,
                        ).catch((e) => setError(describeError(e)))
                      }
                    >
                      Tải tệp
                    </button>
                  )}
                  {itemDecision(c.id, c.status)}
                </li>
              ))}
            </ul>

            <h3>Môn dạy</h3>
            <ul className="stack">
              {p.subjects.map((s) => (
                <li key={s.id}>
                  {s.subject}, {gradesLabel(s)}
                  {s.suggestedFee && `, ${formatMoney(s.suggestedFee)}/buổi`}{' '}
                  <Badge tone={ITEM_STATUS[s.status][1]}>{ITEM_STATUS[s.status][0]}</Badge>{' '}
                  {itemDecision(s.id, s.status)}
                </li>
              ))}
            </ul>

            <h3>Khu vực và giờ rảnh</h3>
            <p>{p.areas.map(areaLabel).join('; ') || '—'}</p>
            <p>
              {p.availability
                .map((a) => `${WEEKDAY_LABEL[a.weekday]} ${a.startTime}–${a.endTime}`)
                .join('; ') || '—'}
            </p>

            {DECISIONS_FOR[p.status].length > 0 && (
              <>
                <Field label="Lý do" hint="Bắt buộc khi yêu cầu bổ sung, từ chối hoặc tạm khóa">
                  <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <div className="row" style={{ marginTop: '0.5rem' }}>
                  {DECISIONS_FOR[p.status].map((d) => (
                    <ActionButton
                      key={d}
                      variant={d === 'VERIFY' || d === 'REINSTATE' ? 'primary' : 'danger'}
                      onClick={() => decide(p, d)}
                    >
                      {DECISION_LABEL[d]}
                    </ActionButton>
                  ))}
                </div>
              </>
            )}
            <ErrorBox error={error} />
            {done && <Notice tone="success">{done}</Notice>}

            {p.reviews && p.reviews.length > 0 && (
              <>
                <h3>Lịch sử duyệt</h3>
                <ul>
                  {p.reviews.map((r, i) => (
                    <li key={i}>
                      <DateTime value={r.createdAt} />: {DECISION_LABEL[r.decision]}
                      {r.reason && ` – ${r.reason}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Loaded>
    </section>
  );
}
