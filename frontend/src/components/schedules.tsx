'use client';
/**
 * A Class's recurring Schedules: list, create with a preview of the Sessions and their
 * conflicts (BR-SC-01), and end one. Schedules are immutable (BR-SC-07).
 */
import { useState } from 'react';
import {
  ActionButton,
  Confirm,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { ApiError, api, describeError } from '@/lib/api';
import { addDays, formatDate, todayVn, WEEKDAY_LABEL } from '@/lib/format';
import type { Conflict, ScheduleView } from '@/lib/types';

interface Preview {
  sessions: { date: string; startTime: string; endTime: string }[];
  conflicts: Conflict[];
}

export function SchedulesSection({ classId, open }: { classId: string; open: boolean }) {
  const list = useLoad(() => api.get<ScheduleView[]>('/schedules', { classId }), [classId]);
  const [weekday, setWeekday] = useState('1');
  const [startTime, setStartTime] = useState('19:00');
  const [endTime, setEndTime] = useState('20:30');
  const [fromDate, setFromDate] = useState(addDays(todayVn(), 1));
  const [toDate, setToDate] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [ending, setEnding] = useState<ScheduleView | null>(null);

  const body = (skipConflicts = false) => ({
    classId,
    weekday: Number(weekday),
    startTime,
    endTime,
    fromDate,
    ...(toDate && { toDate }),
    ...(skipConflicts && { skipConflicts: true }),
  });
  const reset = () => setPreview(null);

  async function save(skipConflicts: boolean) {
    setError('');
    try {
      const res = await api.post<{ sessionsCreated: number; skipped: Conflict[] }>(
        '/schedules',
        body(skipConflicts),
      );
      setMessage(
        `Đã tạo lịch lặp và sinh ${res.data.sessionsCreated} buổi học${res.data.skipped.length ? `, bỏ qua ${res.data.skipped.length} buổi bị trùng` : ''}.`,
      );
      setPreview(null);
      list.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const conflicts = (err.body as { conflicts?: Conflict[] })?.conflicts ?? [];
        setPreview((p) => (p ? { ...p, conflicts } : p));
        setError(
          'Có buổi bị trùng giờ với lớp khác của bạn. Chọn giờ khác, hoặc lưu và bỏ qua các buổi trùng.',
        );
      } else setError(describeError(err));
    }
  }

  return (
    <section aria-label="Lịch lặp">
      <h2>Lịch lặp</h2>
      <p className="hint">
        Lịch lặp không sửa được (BR-SC-07): muốn đổi giờ, hãy kết thúc lịch cũ và tạo lịch mới. Hệ
        thống sinh sẵn buổi học cho 3 tháng tới.
      </p>
      {message && <Notice tone="success">{message}</Notice>}
      <Loaded state={list}>
        {(schedules) =>
          schedules.length === 0 ? (
            <Empty>Lớp chưa có lịch lặp.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Thứ</th>
                    <th>Giờ</th>
                    <th>Từ ngày</th>
                    <th>Đến ngày</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.id}>
                      <td>{WEEKDAY_LABEL[s.weekday]}</td>
                      <td>
                        {s.startTime}–{s.endTime}
                      </td>
                      <td>{formatDate(s.fromDate)}</td>
                      <td>{s.toDate ? formatDate(s.toDate) : 'Không giới hạn'}</td>
                      <td>
                        {s.endedAt ? (
                          <span className="muted">Đã kết thúc</span>
                        ) : (
                          open && (
                            <button className="btn secondary small" onClick={() => setEnding(s)}>
                              Kết thúc lịch
                            </button>
                          )
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
        open={ending !== null}
        title="Kết thúc lịch lặp này?"
        confirmLabel="Kết thúc lịch"
        onCancel={() => setEnding(null)}
        onConfirm={async () => {
          setError('');
          try {
            const res = await api.delete<{ sessionsCancelled: number }>(`/schedules/${ending!.id}`);
            setMessage(`Đã kết thúc lịch lặp và hủy ${res.data.sessionsCancelled} buổi tương lai.`);
            list.reload();
          } catch (err) {
            setError(describeError(err));
          }
          setEnding(null);
        }}
      >
        <p>
          Các buổi học tương lai của lịch này sẽ bị hủy; học sinh và phụ huynh được báo. Buổi đã học
          không đổi.
        </p>
      </Confirm>

      {open && (
        <form
          className="card stack"
          onSubmit={(e) => e.preventDefault()}
          aria-label="Tạo lịch lặp"
          style={{ marginTop: '1rem' }}
        >
          <strong>Tạo lịch lặp</strong>
          <div className="grid">
            <Field label="Thứ trong tuần">
              <select value={weekday} onChange={(e) => (setWeekday(e.target.value), reset())}>
                {Object.entries(WEEKDAY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Giờ bắt đầu">
              <input
                type="time"
                value={startTime}
                onChange={(e) => (setStartTime(e.target.value), reset())}
              />
            </Field>
            <Field label="Giờ kết thúc">
              <input
                type="time"
                value={endTime}
                onChange={(e) => (setEndTime(e.target.value), reset())}
              />
            </Field>
            <Field label="Từ ngày">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => (setFromDate(e.target.value), reset())}
              />
            </Field>
            <Field label="Đến ngày" hint="Để trống nếu không giới hạn">
              <input
                type="date"
                value={toDate}
                onChange={(e) => (setToDate(e.target.value), reset())}
              />
            </Field>
          </div>
          <div className="row">
            <ActionButton
              variant="secondary"
              busyLabel="Đang xem trước…"
              onClick={async () => {
                setError('');
                setMessage('');
                try {
                  setPreview((await api.post<Preview>('/schedules/preview', body())).data);
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            >
              Xem trước
            </ActionButton>
            {preview && (
              <>
                <ActionButton disabled={preview.conflicts.length > 0} onClick={() => save(false)}>
                  Lưu lịch lặp
                </ActionButton>
                {preview.conflicts.length > 0 && (
                  <ActionButton variant="danger" onClick={() => save(true)}>
                    Lưu và bỏ qua {preview.conflicts.length} buổi trùng
                  </ActionButton>
                )}
              </>
            )}
          </div>
          {preview && (
            <div aria-label="Xem trước buổi học">
              <p>
                Sẽ sinh <b>{preview.sessions.length}</b> buổi
                {preview.sessions[0] && ` (buổi đầu ${formatDate(preview.sessions[0].date)})`}.
              </p>
              {preview.conflicts.length > 0 && (
                <div className="alert warning" role="status">
                  <div>
                    <b>{preview.conflicts.length} buổi bị trùng giờ:</b>
                    <ul style={{ paddingLeft: '1.2rem' }}>
                      {preview.conflicts.map((c) => (
                        <li key={c.date}>
                          {formatDate(c.date)} {c.startTime}–{c.endTime} trùng buổi{' '}
                          {c.conflictsWith.startTime}–{c.conflictsWith.endTime} của lớp khác
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
          <ErrorBox error={error} />
        </form>
      )}
    </section>
  );
}
