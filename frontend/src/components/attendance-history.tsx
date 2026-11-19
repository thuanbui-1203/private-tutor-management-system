'use client';
/** One Student's Attendance for a month: only their own records (BR-SC-10). */
import { useState } from 'react';
import { AttendanceBadge } from '@/components/badges';
import { Empty, Field, Loaded, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, todayVn } from '@/lib/format';
import { ATTENDANCE_LABEL } from '@/lib/labels';
import type { AttendanceHistory, AttendanceStatus } from '@/lib/types';

export function AttendanceHistoryView({
  studentId,
  classNames,
}: {
  studentId: string;
  /** classId → name, when the viewer can list Classes (Tutor); otherwise not shown. */
  classNames?: Map<string, string>;
}) {
  const [month, setMonth] = useState(todayVn().slice(0, 7));
  const history = useLoad(
    () => api.get<AttendanceHistory>(`/students/${studentId}/attendance`, { month }),
    [studentId, month],
  );
  return (
    <section aria-label="Chuyên cần">
      <Field label="Tháng">
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          style={{ maxWidth: 200 }}
        />
      </Field>
      <Loaded state={history}>
        {(h) => (
          <>
            <p className="row" style={{ margin: '0.5rem 0' }}>
              {(Object.keys(ATTENDANCE_LABEL) as AttendanceStatus[]).map((s) => (
                <span key={s}>
                  {ATTENDANCE_LABEL[s]}: <b>{h.summary[s]}</b>
                </span>
              ))}
            </p>
            {h.records.length === 0 ? (
              <Empty>Không có buổi học nào được điểm danh trong tháng này.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Giờ</th>
                      {classNames && <th>Lớp</th>}
                      <th>Trạng thái</th>
                      <th>Ghi chú</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.records.map((r) => (
                      <tr key={r.sessionId}>
                        <td>{formatDate(r.date)}</td>
                        <td>
                          {r.startTime}–{r.endTime}
                        </td>
                        {classNames && <td>{classNames.get(r.classId) ?? '—'}</td>}
                        <td>
                          <AttendanceBadge status={r.status} />
                        </td>
                        <td>{r.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Loaded>
    </section>
  );
}
