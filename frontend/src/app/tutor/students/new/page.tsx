'use client';
/**
 * Create a Student with their Parents (BR-ST-04: a minor needs a primary Parent; BR-ST-06:
 * exactly one primary). The checks here only spare a round trip; student-service decides.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ErrorBox, Field, Notice } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ageOn } from '@/lib/format';
import { emptyParent, studentFormProblems, type ParentRow } from '@/lib/rules';
import type { InvitationOutcome, StudentView } from '@/lib/types';

/** POST /students: `parentInvitation` is there when the Student and the primary Parent were both invited. */
type Created = StudentView & {
  invitation: InvitationOutcome;
  parentInvitation?: InvitationOutcome;
};

export default function NewStudentPage() {
  const router = useRouter();
  const { session } = useAuth();
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [email, setEmail] = useState('');
  const [school, setSchool] = useState('');
  const [grade, setGrade] = useState('');
  const [note, setNote] = useState('');
  const [invite, setInvite] = useState(true);
  const [parents, setParents] = useState<ParentRow[]>([emptyParent(true)]);
  const [error, setError] = useState<string>('');
  const [created, setCreated] = useState<Created | null>(null);

  const minor = dob ? ageOn(dob) < 18 : false;
  const setParent = (i: number, patch: Partial<ParentRow>) =>
    setParents((ps) =>
      ps.map((p, j) =>
        j === i ? { ...p, ...patch } : patch.isPrimary ? { ...p, isPrimary: false } : p,
      ),
    );

  async function submit() {
    setError('');
    if (!fullName.trim() || !dob) return setError('Cần nhập họ tên và ngày sinh.');
    const problems = studentFormProblems(dob, email, parents);
    if (problems.length) return setError(problems.join(' '));
    const body = {
      // An Admin creates Students on their own account (they can teach, BR-AU-01).
      ...(session?.role === 'ADMIN' && session.userId && { tutorId: session.userId }),
      fullName: fullName.trim(),
      dob,
      ...(email.trim() && { email: email.trim() }),
      ...(school.trim() && { school: school.trim() }),
      ...(grade && { grade: Number(grade) }),
      ...(note.trim() && { note: note.trim() }),
      invite,
      parents: parents
        .filter((p) => p.fullName.trim())
        .map((p) => ({
          fullName: p.fullName.trim(),
          phone: p.phone.trim(),
          ...(p.email.trim() && { email: p.email.trim() }),
          isPrimary: p.isPrimary,
        })),
    };
    try {
      const res = await api.post<Created>('/students', body);
      setCreated(res.data);
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (created) {
    const inv = created.invitation;
    return (
      <>
        <h1>Đã thêm học sinh {created.fullName}</h1>
        {inv.status === 'sent' && (
          <Notice tone="success">
            Đã gửi lời mời kích hoạt tài khoản tới {inv.email} (
            {inv.to === 'STUDENT' ? 'học sinh' : 'phụ huynh chính'}).
          </Notice>
        )}
        {inv.status === 'skipped' && (
          <Notice tone="info">Chưa gửi lời mời: không có email để gửi.</Notice>
        )}
        {inv.status === 'failed' && (
          <Notice tone="warning">
            Hồ sơ đã lưu nhưng chưa gửi được lời mời. Bạn có thể gửi lại trong trang học sinh.
          </Notice>
        )}
        {created.parentInvitation?.status === 'sent' && (
          <Notice tone="success">
            Đã gửi lời mời kích hoạt tài khoản tới {created.parentInvitation.email} (phụ huynh
            chính).
          </Notice>
        )}
        {created.parentInvitation?.status === 'failed' && (
          <Notice tone="warning">Chưa gửi được lời mời cho phụ huynh chính.</Notice>
        )}
        <div className="row">
          <button
            className="btn primary"
            onClick={() => router.push(`/tutor/students/${created.id}`)}
          >
            Xem hồ sơ
          </button>
          <button className="btn secondary" onClick={() => router.push('/tutor/students')}>
            Về danh sách
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Thêm học sinh</h1>
      <form className="card stack" onSubmit={(e) => e.preventDefault()}>
        <div className="grid">
          <Field label="Họ tên học sinh">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Ngày sinh">
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </Field>
          <Field
            label="Email học sinh"
            hint={minor ? 'Không bắt buộc với học sinh dưới 18 tuổi' : undefined}
          >
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
        <Field label="Ghi chú riêng" hint="Chỉ giáo viên và quản trị viên thấy (BR-ST-07)">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <h2>Phụ huynh</h2>
        {minor && (
          <p className="hint">Học sinh dưới 18 tuổi: phụ huynh chính là người nhận hóa đơn.</p>
        )}
        {parents.map((p, i) => (
          <fieldset key={i} className="card" aria-label={`Phụ huynh ${i + 1}`}>
            <div className="grid">
              <Field label={`Họ tên phụ huynh ${i + 1}`}>
                <input
                  value={p.fullName}
                  onChange={(e) => setParent(i, { fullName: e.target.value })}
                />
              </Field>
              <Field label={`Số điện thoại phụ huynh ${i + 1}`}>
                <input value={p.phone} onChange={(e) => setParent(i, { phone: e.target.value })} />
              </Field>
              <Field label={`Email phụ huynh ${i + 1}`}>
                <input
                  type="email"
                  value={p.email}
                  onChange={(e) => setParent(i, { email: e.target.value })}
                />
              </Field>
            </div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <label className="checkbox">
                <input
                  type="radio"
                  name="primary"
                  checked={p.isPrimary}
                  onChange={() => setParent(i, { isPrimary: true })}
                />
                Phụ huynh chính (người thanh toán)
              </label>
              <button
                type="button"
                className="link"
                onClick={() => setParents((ps) => ps.filter((_, j) => j !== i))}
              >
                Bỏ phụ huynh này
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="btn secondary"
          onClick={() => setParents((ps) => [...ps, emptyParent(ps.length === 0)])}
        >
          Thêm phụ huynh
        </button>

        <label className="checkbox">
          <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
          Gửi lời mời kích hoạt tài khoản ngay
        </label>
        <ErrorBox error={error} />
        <ActionButton type="submit" onClick={submit} busyLabel="Đang lưu…">
          Lưu học sinh
        </ActionButton>
      </form>
    </>
  );
}
