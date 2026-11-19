'use client';
import Link from 'next/link';
import { useState } from 'react';
import { StudentStatusBadge } from '@/components/badges';
import { DateText, Empty, Field, Loaded, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { STUDENT_STATUS_LABEL } from '@/lib/labels';
import type { Page, StudentView } from '@/lib/types';

export default function StudentsPage() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(
    () => api.get<Page<StudentView>>('/students', { status, q: search, page, pageSize: 20 }),
    [status, search, page],
  );

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Học sinh</h1>
        <Link className="btn primary" href="/tutor/students/new">
          Thêm học sinh
        </Link>
      </div>
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(q.trim());
        }}
      >
        <Field label="Tìm theo tên">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nguyễn…" />
        </Field>
        <Field label="Trạng thái">
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">Tất cả</option>
            {Object.entries(STUDENT_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn secondary" type="submit" style={{ alignSelf: 'flex-end' }}>
          Tìm
        </button>
      </form>
      <Loaded state={list}>
        {(res) =>
          res.items.length === 0 ? (
            <Empty>Chưa có học sinh nào{search || status ? ' khớp bộ lọc' : ''}.</Empty>
          ) : (
            <>
              <div className="table-wrap" style={{ marginTop: '1rem' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Họ tên</th>
                      <th>Ngày sinh</th>
                      <th>Trường / lớp</th>
                      <th>Phụ huynh chính</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.items.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link href={`/tutor/students/${s.id}`}>{s.fullName}</Link>
                        </td>
                        <td>
                          <DateText value={s.dob} />
                        </td>
                        <td>
                          {[s.school, s.grade && `Lớp ${s.grade}`].filter(Boolean).join(' · ') ||
                            '—'}
                        </td>
                        <td>{s.parents.find((p) => p.isPrimary)?.fullName ?? '—'}</td>
                        <td>
                          <StudentStatusBadge status={s.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ marginTop: '0.75rem' }}>
                <span className="muted">
                  {res.total} học sinh · trang {res.page}/
                  {Math.max(1, Math.ceil(res.total / res.pageSize))}
                </span>
                <button
                  className="btn secondary small"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Trang trước
                </button>
                <button
                  className="btn secondary small"
                  disabled={page * res.pageSize >= res.total}
                  onClick={() => setPage(page + 1)}
                >
                  Trang sau
                </button>
              </div>
            </>
          )
        }
      </Loaded>
    </>
  );
}
