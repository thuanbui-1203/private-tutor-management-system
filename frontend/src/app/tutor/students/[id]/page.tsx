'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttendanceHistoryView } from '@/components/attendance-history';
import { EnrollmentBadge, StudentStatusBadge } from '@/components/badges';
import { BalanceSection } from '@/components/invoice';
import {
  ActionButton,
  Confirm,
  DateText,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { ageOn } from '@/lib/format';
import { FEE_TYPE_LABEL, STUDENT_STATUS_LABEL } from '@/lib/labels';
import type { StudentClassView, StudentStatus, StudentView } from '@/lib/types';

/** docs/diagrams/09: which statuses a Student can move to (GRADUATED is final). */
const NEXT_STATUS: Record<StudentStatus, StudentStatus[]> = {
  ACTIVE: ['PAUSED', 'GRADUATED', 'DROPPED'],
  PAUSED: ['ACTIVE', 'DROPPED'],
  DROPPED: ['ACTIVE'],
  GRADUATED: [],
};
const STATUS_EFFECT: Partial<Record<StudentStatus, string>> = {
  PAUSED: 'Các ghi danh sẽ tạm dừng; sau 60 ngày tạm nghỉ, học sinh tự chuyển sang nghỉ học.',
  DROPPED: 'Học sinh sẽ được rút khỏi mọi lớp. Các buổi đã học vẫn được tính phí (BR-BI-09).',
  GRADUATED: 'Học sinh sẽ được rút khỏi mọi lớp và không thể học lại.',
};

export default function StudentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const student = useLoad(() => api.get<StudentView>(`/students/${id}`), [id]);
  const classes = useLoad(() => api.get<StudentClassView[]>(`/students/${id}/classes`), [id]);
  const [editing, setEditing] = useState(false);
  const [nextStatus, setNextStatus] = useState<StudentStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>('');

  return (
    <Loaded state={student}>
      {(s) => {
        const primary = s.parents.find((p) => p.isPrimary);
        const inviteTarget = s.email
          ? { email: s.email, fullName: s.fullName, role: 'STUDENT' as const, who: 'học sinh' }
          : primary?.email
            ? {
                email: primary.email,
                fullName: primary.fullName,
                role: 'PARENT' as const,
                who: 'phụ huynh chính',
              }
            : null;
        return (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h1>
                {s.fullName} <StudentStatusBadge status={s.status} />
              </h1>
              <Link href="/tutor/students">← Danh sách học sinh</Link>
            </div>
            {message && <Notice tone="success">{message}</Notice>}
            <ErrorBox error={error} />

            {editing ? (
              <EditStudent
                student={s}
                onDone={(updated) => {
                  setEditing(false);
                  if (updated) {
                    student.setData({ ...s, ...updated });
                    setMessage('Đã lưu thay đổi.');
                  }
                }}
              />
            ) : (
              <section className="card">
                <div className="grid">
                  <div>
                    <div className="hint">Ngày sinh</div>
                    <DateText value={s.dob} /> ({ageOn(s.dob)} tuổi)
                  </div>
                  <div>
                    <div className="hint">Email</div>
                    {s.email ?? '—'}
                  </div>
                  <div>
                    <div className="hint">Trường / lớp</div>
                    {[s.school, s.grade && `Lớp ${s.grade}`].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <div>
                    <div className="hint">Người thanh toán</div>
                    {s.payer === 'SELF'
                      ? 'Học sinh tự thanh toán'
                      : `Phụ huynh chính${primary ? `: ${primary.fullName}` : ''}`}
                    {s.payerContact && (
                      <div className="hint">
                        {[s.payerContact.email, s.payerContact.phone].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
                {s.note !== undefined && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div className="hint">Ghi chú riêng (phụ huynh không thấy)</div>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{s.note || '—'}</p>
                  </div>
                )}
                <div className="row" style={{ marginTop: '0.75rem' }}>
                  <button className="btn secondary" onClick={() => setEditing(true)}>
                    Sửa thông tin
                  </button>
                  {inviteTarget && (
                    <ActionButton
                      variant="secondary"
                      busyLabel="Đang gửi…"
                      onClick={async () => {
                        setError('');
                        setMessage('');
                        try {
                          await api.post('/auth/invitations', {
                            email: inviteTarget.email,
                            fullName: inviteTarget.fullName,
                            role: inviteTarget.role,
                          });
                          setMessage(
                            `Đã gửi lời mời tới ${inviteTarget.who} (${inviteTarget.email}). Lời mời cũ (nếu có) hết hiệu lực.`,
                          );
                        } catch (err) {
                          setError(
                            describeError(err, {
                              409: 'Tài khoản này đã được kích hoạt, không cần mời lại.',
                            }),
                          );
                        }
                      }}
                    >
                      Gửi lại lời mời
                    </ActionButton>
                  )}
                </div>
              </section>
            )}

            <h2>Trạng thái</h2>
            <div className="row">
              {NEXT_STATUS[s.status].length === 0 && (
                <span className="muted">Học sinh đã hoàn thành, không đổi được nữa.</span>
              )}
              {NEXT_STATUS[s.status].map((to) => (
                <button key={to} className="btn secondary" onClick={() => setNextStatus(to)}>
                  Chuyển sang “{STUDENT_STATUS_LABEL[to]}”
                </button>
              ))}
            </div>
            <Confirm
              open={nextStatus !== null}
              title={`Chuyển sang “${nextStatus ? STUDENT_STATUS_LABEL[nextStatus] : ''}”?`}
              confirmLabel="Xác nhận"
              onCancel={() => setNextStatus(null)}
              onConfirm={async () => {
                setError('');
                try {
                  await api.post(`/students/${id}/status`, { status: nextStatus });
                  setMessage(`Đã chuyển sang “${STUDENT_STATUS_LABEL[nextStatus!]}”.`);
                  setNextStatus(null);
                  student.reload();
                  classes.reload();
                } catch (err) {
                  setNextStatus(null);
                  setError(describeError(err));
                }
              }}
            >
              <p>{nextStatus && STATUS_EFFECT[nextStatus]}</p>
            </Confirm>

            <h2>Phụ huynh</h2>
            {s.parents.length === 0 ? (
              <Empty>Chưa có phụ huynh.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Họ tên</th>
                      <th>Điện thoại</th>
                      <th>Email</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.parents.map((p) => (
                      <tr key={p.id}>
                        <td>{p.fullName}</td>
                        <td>{p.phone ?? '—'}</td>
                        <td>{p.email ?? '—'}</td>
                        <td>
                          {p.isPrimary && <span className="badge blue">Phụ huynh chính</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Công nợ</h2>
            <BalanceSection studentId={s.id} invoiceHref={(i) => `/tutor/invoices/${i}`} />

            <h2>Chuyên cần</h2>
            <AttendanceHistoryView
              studentId={s.id}
              classNames={new Map((classes.data ?? []).map((c) => [c.class.id, c.class.name]))}
            />

            <h2>Lớp đang học</h2>
            <Loaded state={classes}>
              {(list) =>
                list.length === 0 ? (
                  <Empty>Chưa ghi danh lớp nào.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Lớp</th>
                          <th>Học phí</th>
                          <th>Vào lớp</th>
                          <th>Trạng thái</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((c) => (
                          <tr key={c.enrollmentId}>
                            <td>
                              <Link href={`/tutor/classes/${c.class.id}`}>{c.class.name}</Link>
                              <div className="hint">{c.class.subject}</div>
                            </td>
                            <td>{FEE_TYPE_LABEL[c.class.feeType]}</td>
                            <td>
                              <DateText value={c.joinedAt} />
                            </td>
                            <td>
                              <EnrollmentBadge status={c.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </Loaded>
          </>
        );
      }}
    </Loaded>
  );
}

function EditStudent({
  student,
  onDone,
}: {
  student: StudentView;
  onDone: (updated?: StudentView) => void;
}) {
  const [fullName, setFullName] = useState(student.fullName);
  const [email, setEmail] = useState(student.email ?? '');
  const [school, setSchool] = useState(student.school ?? '');
  const [grade, setGrade] = useState(student.grade ? String(student.grade) : '');
  const [note, setNote] = useState(student.note ?? '');
  const [error, setError] = useState('');
  return (
    <form className="card stack" onSubmit={(e) => e.preventDefault()}>
      <div className="grid">
        <Field label="Họ tên học sinh">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Email học sinh">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Trường">
          <input value={school} onChange={(e) => setSchool(e.target.value)} />
        </Field>
        <Field label="Khối lớp">
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">—</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
              <option key={g} value={g}>
                Lớp {g}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Ghi chú riêng" hint="Chỉ giáo viên và quản trị viên thấy">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
      <div className="row">
        <ActionButton
          type="submit"
          busyLabel="Đang lưu…"
          onClick={async () => {
            setError('');
            try {
              const res = await api.patch<StudentView>(`/students/${student.id}`, {
                fullName: fullName.trim(),
                email: email.trim() || null,
                school: school.trim() || null,
                grade: grade ? Number(grade) : null,
                note: note.trim() || null,
              });
              onDone(res.data);
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          Lưu
        </ActionButton>
        <button type="button" className="btn secondary" onClick={() => onDone()}>
          Hủy
        </button>
      </div>
    </form>
  );
}
