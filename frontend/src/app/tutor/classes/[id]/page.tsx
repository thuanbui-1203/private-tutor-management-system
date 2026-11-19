'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EnrollmentBadge } from '@/components/badges';
import {
  ActionButton,
  Badge,
  Confirm,
  DateText,
  DateTime,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Money,
  Notice,
  useLoad,
} from '@/components/ui';
import { ApiError, api, describeError, request } from '@/lib/api';
import { formatDateTime, formatPeriod, nextPeriod, todayVn } from '@/lib/format';
import { FEE_TYPE_LABEL } from '@/lib/labels';
import type { ClassView, EnrollmentView, Page, StudentView } from '@/lib/types';

export default function ClassDetailPage() {
  const { id } = useParams<{ id: string }>();
  const cls = useLoad(() => api.get<ClassView>(`/classes/${id}`), [id]);
  const roster = useLoad(() => api.get<EnrollmentView[]>(`/classes/${id}/students`), [id]);
  const [message, setMessage] = useState<{
    tone: 'success' | 'info' | 'warning';
    text: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [withdrawing, setWithdrawing] = useState<EnrollmentView | null>(null);

  async function changeEnrollment(e: EnrollmentView, status: 'ACTIVE' | 'PAUSED' | 'WITHDRAWN') {
    setError('');
    try {
      await api.patch(`/classes/${id}/enrollments/${e.id}`, { status });
      roster.reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <Loaded state={cls}>
      {(c) => (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1>
              {c.name}{' '}
              {c.status === 'OPEN' ? <Badge tone="green">Đang mở</Badge> : <Badge>Đã đóng</Badge>}
            </h1>
            <Link href="/tutor/classes">← Danh sách lớp</Link>
          </div>
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
          <ErrorBox error={error} />

          <section className="card">
            <div className="grid">
              <div>
                <div className="hint">Môn</div>
                {c.subject}
              </div>
              <div>
                <div className="hint">Loại</div>
                {c.type === 'GROUP' ? `Nhóm, tối đa ${c.maxStudents} học sinh` : '1-1'}
              </div>
              <div>
                <div className="hint">Học phí hiện hành</div>
                <Money value={c.feeAmount} /> / {c.feeType === 'MONTHLY' ? 'tháng' : 'buổi'} (
                {FEE_TYPE_LABEL[c.feeType]})
                <div className="hint">Áp dụng từ kỳ {formatPeriod(c.feeEffectiveFrom)}</div>
              </div>
              <div>
                <div className="hint">Buổi vắng không phép</div>
                {c.chargeAbsent ? 'Có tính phí' : 'Không tính phí'}
              </div>
            </div>
          </section>

          {c.status === 'OPEN' && (
            <FeeEditor
              cls={c}
              onSaved={(updated) => {
                cls.setData(updated);
                setMessage({
                  tone: 'info',
                  text: `Đã lưu học phí mới. Mức mới áp dụng từ kỳ ${formatPeriod(updated.feeEffectiveFrom)}; các hóa đơn của kỳ trước không thay đổi (BR-CL-04).`,
                });
              }}
            />
          )}

          <h2>Danh sách lớp</h2>
          {c.status === 'OPEN' && (
            <EnrollForm
              classId={c.id}
              onResult={(text, tone) => {
                setMessage({ text, tone });
                roster.reload();
              }}
            />
          )}
          <Loaded state={roster}>
            {(list) =>
              list.length === 0 ? (
                <Empty>Lớp chưa có học sinh.</Empty>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Học sinh</th>
                        <th>Vào lớp</th>
                        <th>Trạng thái</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((e) => (
                        <tr key={e.id}>
                          <td>
                            <Link href={`/tutor/students/${e.studentId}`}>{e.studentName}</Link>
                          </td>
                          <td>
                            <DateText value={e.joinedAt} />
                          </td>
                          <td>
                            <EnrollmentBadge status={e.status} />
                            {e.status === 'AWAITING_PAYMENT' && e.paymentDeadline && (
                              <div className="hint">
                                Hạn thanh toán hóa đơn ghi danh:{' '}
                                <DateTime value={e.paymentDeadline} />
                              </div>
                            )}
                            {e.status === 'PENDING' && (
                              <div className="hint">Đang chờ xác nhận học sinh</div>
                            )}
                          </td>
                          <td className="row">
                            {e.status === 'ACTIVE' && (
                              <button
                                className="btn secondary small"
                                onClick={() => changeEnrollment(e, 'PAUSED')}
                              >
                                Tạm dừng
                              </button>
                            )}
                            {e.status === 'PAUSED' && (
                              <button
                                className="btn secondary small"
                                onClick={() => changeEnrollment(e, 'ACTIVE')}
                              >
                                Học lại
                              </button>
                            )}
                            {e.status !== 'PENDING' && (
                              <button
                                className="btn secondary small"
                                onClick={() => setWithdrawing(e)}
                              >
                                Rút khỏi lớp
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Loaded>
          <Confirm
            open={withdrawing !== null}
            title={`Rút ${withdrawing?.studentName ?? ''} khỏi lớp?`}
            confirmLabel="Rút khỏi lớp"
            onCancel={() => setWithdrawing(null)}
            onConfirm={async () => {
              const e = withdrawing!;
              setWithdrawing(null);
              await changeEnrollment(e, 'WITHDRAWN');
            }}
          >
            <p>
              Học sinh không còn trong các buổi học sắp tới. Các buổi đã học và hóa đơn đã phát hành
              không thay đổi.
            </p>
          </Confirm>

          {c.status === 'OPEN' && (
            <>
              <h2>Đóng lớp</h2>
              <button className="btn danger" onClick={() => setClosing(true)}>
                Đóng lớp
              </button>
              <Confirm
                open={closing}
                title="Đóng lớp này?"
                confirmLabel="Đóng lớp"
                onCancel={() => setClosing(false)}
                onConfirm={async () => {
                  setError('');
                  try {
                    const res = await api.post<ClassView>(`/classes/${id}/close`);
                    setClosing(false);
                    cls.setData(res.data);
                    roster.reload();
                    setMessage({ tone: 'success', text: 'Đã đóng lớp.' });
                  } catch (err) {
                    setClosing(false);
                    setError(describeError(err));
                  }
                }}
              >
                <ul style={{ paddingLeft: '1.2rem' }}>
                  <li>Mọi học sinh trong lớp được rút khỏi lớp.</li>
                  <li>Các buổi học tương lai bị hủy và lịch lặp kết thúc.</li>
                  <li>Không mở lại được lớp đã đóng.</li>
                </ul>
              </Confirm>
            </>
          )}
        </>
      )}
    </Loaded>
  );
}

function FeeEditor({ cls, onSaved }: { cls: ClassView; onSaved: (c: ClassView) => void }) {
  const [open, setOpen] = useState(false);
  const [feeAmount, setFeeAmount] = useState(String(cls.feeAmount));
  const [chargeAbsent, setChargeAbsent] = useState(cls.chargeAbsent);
  const [error, setError] = useState('');
  if (!open) {
    return (
      <button className="btn secondary" onClick={() => setOpen(true)}>
        Đổi học phí
      </button>
    );
  }
  return (
    <form className="card stack" onSubmit={(e) => e.preventDefault()}>
      <Notice tone="info">
        Học phí mới sẽ áp dụng từ kỳ {formatPeriod(nextPeriod(todayVn().slice(0, 7)))}. Hóa đơn của
        tháng này giữ mức cũ.
      </Notice>
      <Field
        label={
          cls.feeType === 'MONTHLY' ? 'Học phí mới mỗi tháng (VND)' : 'Học phí mới mỗi buổi (VND)'
        }
      >
        <input
          type="number"
          min={1}
          step={1000}
          value={feeAmount}
          onChange={(e) => setFeeAmount(e.target.value)}
        />
      </Field>
      {cls.feeType === 'PER_SESSION' && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={chargeAbsent}
            onChange={(e) => setChargeAbsent(e.target.checked)}
          />
          Tính phí buổi vắng không phép
        </label>
      )}
      <ErrorBox error={error} />
      <div className="row">
        <ActionButton
          type="submit"
          busyLabel="Đang lưu…"
          onClick={async () => {
            setError('');
            const fee = Number(feeAmount);
            if (!Number.isInteger(fee) || fee <= 0)
              return setError('Học phí phải là số nguyên VND lớn hơn 0.');
            try {
              const res = await api.patch<ClassView>(`/classes/${cls.id}`, {
                feeAmount: fee,
                chargeAbsent,
              });
              setOpen(false);
              onSaved(res.data);
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          Lưu học phí
        </ActionButton>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
          Hủy
        </button>
      </div>
    </form>
  );
}

function EnrollForm({
  classId,
  onResult,
}: {
  classId: string;
  onResult: (text: string, tone: 'success' | 'info' | 'warning') => void;
}) {
  const students = useLoad(() =>
    api.get<Page<StudentView>>('/students', { status: 'ACTIVE', pageSize: 100 }),
  );
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="card row" onSubmit={(e) => e.preventDefault()} aria-label="Ghi danh">
      <Field label="Ghi danh học sinh">
        <select
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          style={{ minWidth: 240 }}
        >
          <option value="">— Chọn học sinh —</option>
          {students.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
      </Field>
      <ActionButton
        type="submit"
        disabled={!studentId}
        busyLabel="Đang ghi danh…"
        onClick={async () => {
          setError('');
          try {
            const res = await request<EnrollmentView>('POST', `/classes/${classId}/enrollments`, {
              body: { studentId },
            });
            const e = res.data;
            if (res.status === 202 || e.status === 'PENDING') {
              onResult(
                `Đang xử lý ghi danh ${e.studentName ?? ''}: hệ thống chưa xác nhận được học sinh. Không cần ghi danh lại, trạng thái sẽ tự cập nhật.`,
                'info',
              );
            } else if (e.status === 'AWAITING_PAYMENT') {
              onResult(
                `${e.studentName} đang chờ thanh toán: hóa đơn ghi danh đã được gửi cho người thanh toán, hạn ${formatDateTime(e.paymentDeadline)} (7 ngày). Quá hạn chưa trả, học sinh sẽ tự được rút khỏi lớp.`,
                'warning',
              );
            } else {
              onResult(`Đã ghi danh ${e.studentName} vào lớp.`, 'success');
            }
            setStudentId('');
          } catch (err) {
            setError(
              err instanceof ApiError && err.status === 409 && /full/i.test(err.message)
                ? 'Lớp đã đủ chỗ. Hãy chọn lớp khác hoặc tăng sĩ số.'
                : err instanceof ApiError &&
                    err.status === 409 &&
                    /already enrolled/i.test(err.message)
                  ? 'Học sinh này đã ghi danh vào lớp rồi.'
                  : describeError(err),
            );
          }
        }}
      >
        Ghi danh
      </ActionButton>
      <ErrorBox error={error} />
    </form>
  );
}
