'use client';
/**
 * Whole-class Attendance on one screen (BR-SC-02/03/08/09): four statuses per Student,
 * editable until 48h after the Session ends, then locked.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SessionBadge } from '@/components/badges';
import { ActionButton, Empty, ErrorBox, Loaded, Notice, useLoad } from '@/components/ui';
import { ApiError, api, describeError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { ATTENDANCE_LABEL } from '@/lib/labels';
import type { AttendanceSheet, AttendanceStatus } from '@/lib/types';

const STATUSES: AttendanceStatus[] = ['PRESENT', 'LATE', 'EXCUSED', 'ABSENT'];

export default function AttendancePage() {
  const { id } = useParams<{ id: string }>();
  const sheet = useLoad(() => api.get<AttendanceSheet>(`/sessions/${id}/attendance`), [id]);
  return (
    <>
      <p>
        <Link href="/tutor/schedule">← Lịch dạy</Link>
      </p>
      <Loaded state={sheet}>{(s) => <Sheet sheet={s} onSaved={sheet.reload} />}</Loaded>
    </>
  );
}

function Sheet({ sheet, onSaved }: { sheet: AttendanceSheet; onSaved: () => void }) {
  const { session } = sheet;
  const [marks, setMarks] = useState<
    Record<string, { status: AttendanceStatus | null; note: string }>
  >(() =>
    Object.fromEntries(
      sheet.students.map((st) => [st.studentId, { status: st.status, note: st.note ?? '' }]),
    ),
  );
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const recorded = sheet.students.some((st) => st.status !== null);
  const [now] = useState(Date.now);
  const locked = now > new Date(sheet.editableUntil).getTime();
  const notStarted = now < new Date(session.startsAt).getTime();
  const closed = session.status === 'CANCELLED' || session.status === 'RESCHEDULED';
  const disabled = locked || notStarted || closed;
  const missing = sheet.students.filter((st) => !marks[st.studentId]?.status);

  async function save() {
    setError('');
    setSaved('');
    if (missing.length) return setError(`Còn ${missing.length} học sinh chưa chọn trạng thái.`);
    try {
      await api.put(`/sessions/${session.id}/attendance`, {
        records: sheet.students.map((st) => ({
          studentId: st.studentId,
          status: marks[st.studentId].status,
          ...(marks[st.studentId].note.trim() && { note: marks[st.studentId].note.trim() }),
        })),
      });
      setSaved(
        recorded ? 'Đã lưu bản sửa điểm danh.' : 'Đã lưu điểm danh. Buổi học đã hoàn thành.',
      );
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409 && /locked/i.test(err.message)
          ? 'Điểm danh đã bị khóa vì đã quá 48 giờ sau giờ kết thúc buổi học.'
          : err instanceof ApiError && err.status === 409 && /not started/i.test(err.message)
            ? 'Buổi học chưa bắt đầu, chưa điểm danh được.'
            : describeError(err),
      );
    }
  }

  return (
    <>
      <h1>
        Điểm danh {formatDate(session.date)} {session.startTime}–{session.endTime}{' '}
        <SessionBadge status={session.status} />
      </h1>
      {saved && <Notice tone="success">{saved}</Notice>}
      {locked && (
        <Notice tone="warning">
          Đã quá 48 giờ sau buổi học ({formatDateTime(sheet.editableUntil)}): điểm danh bị khóa và
          không sửa được nữa
          {session.status === 'MISSED' ? '; buổi bỏ lỡ này không tính phí (BR-SC-09)' : ''}.
        </Notice>
      )}
      {!locked && !closed && !notStarted && (
        <p className="hint">
          {recorded ? 'Đang sửa điểm danh. ' : ''}Sửa được đến {formatDateTime(sheet.editableUntil)}{' '}
          (48 giờ sau buổi học).
        </p>
      )}
      {notStarted && (
        <Notice tone="info">Buổi học chưa bắt đầu, chưa điểm danh được (BR-SC-02).</Notice>
      )}
      {closed && <Notice tone="info">Buổi học đã hủy hoặc đã dời, không điểm danh.</Notice>}
      {sheet.students.length === 0 ? (
        <Empty>Lớp không có học sinh nào vào ngày này.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Học sinh</th>
                <th>Trạng thái</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {sheet.students.map((st) => (
                <tr key={st.studentId}>
                  <td>{st.studentName ?? '(học sinh đã rời lớp)'}</td>
                  <td>
                    <div
                      className="row"
                      role="radiogroup"
                      aria-label={`Trạng thái của ${st.studentName}`}
                    >
                      {STATUSES.map((status) => (
                        <label key={status} className="checkbox">
                          <input
                            type="radio"
                            name={`att-${st.studentId}`}
                            disabled={disabled}
                            checked={marks[st.studentId]?.status === status}
                            onChange={() =>
                              setMarks((m) => ({
                                ...m,
                                [st.studentId]: { ...m[st.studentId], status },
                              }))
                            }
                          />
                          {ATTENDANCE_LABEL[status]}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      aria-label={`Ghi chú cho ${st.studentName}`}
                      disabled={disabled}
                      value={marks[st.studentId]?.note ?? ''}
                      onChange={(e) =>
                        setMarks((m) => ({
                          ...m,
                          [st.studentId]: { ...m[st.studentId], note: e.target.value },
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!disabled && sheet.students.length > 0 && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              setMarks((m) =>
                Object.fromEntries(
                  Object.entries(m).map(([k, v]) => [k, { ...v, status: v.status ?? 'PRESENT' }]),
                ),
              )
            }
          >
            Còn lại đều có mặt
          </button>
          <ActionButton onClick={save} busyLabel="Đang lưu…">
            {recorded ? 'Lưu bản sửa' : 'Lưu điểm danh'}
          </ActionButton>
        </div>
      )}
      <p className="hint" style={{ marginTop: '0.75rem' }}>
        Vắng có phép do giáo viên quyết định (BR-SC-08) và không tính phí.
      </p>
      <ErrorBox error={error} />
    </>
  );
}
