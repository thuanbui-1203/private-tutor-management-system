'use client';
/**
 * The Tutor's teaching calendar: week or month, filtered by Class, with every Session's
 * status and actions (start, attendance, cancel + makeup, reschedule), one-off Sessions,
 * and the missed Sessions still waiting for Attendance (BR-SC-09).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { SessionBadge } from '@/components/badges';
import { ActionButton, Empty, ErrorBox, Field, Loaded, Notice, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { conflictText } from '@/lib/conflicts';
import {
  addDays,
  formatDate,
  formatDateTime,
  mondayOf,
  monthEnd,
  todayVn,
  weekdayOf,
} from '@/lib/format';
import type { ClassView, SessionView } from '@/lib/types';

const START_EARLY_MS = 15 * 60_000;

type Mode = 'week' | 'month';

export default function SchedulePage() {
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState(todayVn());
  const [classId, setClassId] = useState('');
  const [message, setMessage] = useState('');
  const from = mode === 'week' ? mondayOf(anchor) : `${anchor.slice(0, 7)}-01`;
  const to = mode === 'week' ? addDays(from, 6) : monthEnd(from);

  const classes = useLoad(() => api.get<ClassView[]>('/classes'));
  const sessions = useLoad(
    () => api.get<SessionView[]>('/sessions', { from, to, classId }),
    [from, to, classId],
  );
  const missed = useLoad(() =>
    api.get<SessionView[]>('/sessions', { from: addDays(todayVn(), -3), to: todayVn() }),
  );
  const names = useMemo(
    () => new Map((classes.data ?? []).map((c) => [c.id, c.name])),
    [classes.data],
  );
  const reloadAll = (text?: string) => {
    if (text) setMessage(text);
    sessions.reload();
    missed.reload();
  };

  const byDate = new Map<string, SessionView[]>();
  for (const s of sessions.data ?? []) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const missedList = (missed.data ?? []).filter((s) => s.status === 'MISSED');

  return (
    <>
      <h1>Lịch dạy</h1>
      {message && <Notice tone="success">{message}</Notice>}
      {missedList.length > 0 && (
        <section className="card" aria-label="Buổi bị bỏ lỡ">
          <h2 style={{ marginTop: 0 }}>Buổi bị bỏ lỡ chưa điểm danh</h2>
          <p className="hint">
            Điểm danh bổ sung trước khi bị khóa (48 giờ sau giờ kết thúc, BR-SC-09).
          </p>
          <ul style={{ paddingLeft: '1.2rem' }}>
            {missedList.map((s) => (
              <li key={s.id}>
                {names.get(s.classId) ?? 'Lớp'} · {formatDate(s.date)} {s.startTime}–{s.endTime} ·{' '}
                <Link href={`/tutor/sessions/${s.id}/attendance`}>Điểm danh bổ sung</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="row">
        <div className="row" role="group" aria-label="Kiểu xem">
          <button
            className={`btn ${mode === 'week' ? 'primary' : 'secondary'} small`}
            onClick={() => setMode('week')}
          >
            Tuần
          </button>
          <button
            className={`btn ${mode === 'month' ? 'primary' : 'secondary'} small`}
            onClick={() => setMode('month')}
          >
            Tháng
          </button>
        </div>
        <button
          className="btn secondary small"
          onClick={() => setAnchor(mode === 'week' ? addDays(from, -7) : addDays(from, -1))}
        >
          ← Trước
        </button>
        <button className="btn secondary small" onClick={() => setAnchor(todayVn())}>
          Hôm nay
        </button>
        <button
          className="btn secondary small"
          onClick={() => setAnchor(mode === 'week' ? addDays(from, 7) : addDays(to, 1))}
        >
          Sau →
        </button>
        <strong>
          {formatDate(from)} – {formatDate(to)}
        </strong>
        <Field label="Lọc theo lớp">
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">Tất cả lớp</option>
            {(classes.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Loaded state={sessions}>
        {() =>
          (sessions.data ?? []).length === 0 ? (
            <Empty>Không có buổi học nào trong khoảng này.</Empty>
          ) : (
            <div className="stack" style={{ marginTop: '1rem' }}>
              {days
                .filter((d) => byDate.has(d))
                .map((d) => (
                  <section key={d} aria-label={`Ngày ${formatDate(d)}`}>
                    <h2>
                      {weekdayOf(d)}, {formatDate(d)}
                    </h2>
                    <div className="stack">
                      {byDate.get(d)!.map((s) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          className={names.get(s.classId) ?? 'Lớp'}
                          names={names}
                          onChanged={reloadAll}
                        />
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )
        }
      </Loaded>

      <OneOffSession classes={classes.data ?? []} names={names} onCreated={reloadAll} />
    </>
  );
}

function SessionCard({
  session: s,
  className,
  names,
  onChanged,
}: {
  session: SessionView;
  className: string;
  names: Map<string, string>;
  onChanged: (message?: string) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'cancel' | 'reschedule' | 'makeup'>('none');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(s.date);
  const [startTime, setStartTime] = useState(s.startTime);
  const [endTime, setEndTime] = useState(s.endTime);
  const [error, setError] = useState('');
  const [now] = useState(Date.now); // the time this card was shown
  const startsAt = new Date(s.startsAt).getTime();
  const endsAt = new Date(s.endsAt).getTime();
  const canStart = s.status === 'SCHEDULED' && now >= startsAt - START_EARLY_MS && now < endsAt;
  const canAttend =
    ['IN_PROGRESS', 'COMPLETED', 'MISSED'].includes(s.status) ||
    (s.status === 'SCHEDULED' && now >= startsAt);
  const canCancel = ['SCHEDULED', 'IN_PROGRESS', 'MISSED'].includes(s.status);
  const canMove = s.status === 'SCHEDULED';

  async function run(
    call: () => Promise<unknown>,
    done: string,
    after: 'none' | 'makeup' = 'none',
  ) {
    setError('');
    try {
      await call();
      setPanel(after);
      onChanged(done);
    } catch (err) {
      setError(conflictText(err, names));
    }
  }

  return (
    <article className="card" aria-label={`${className} ${s.startTime}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>
            {s.startTime}–{s.endTime}
          </strong>{' '}
          · {className} <SessionBadge status={s.status} />
          {s.makeupOf && <span className="hint"> · buổi bù / buổi dời</span>}
          {s.cancelReason && <div className="hint">Lý do hủy: {s.cancelReason}</div>}
        </div>
        <div className="row">
          {canStart && (
            <ActionButton
              variant="secondary"
              onClick={() =>
                run(() => api.post(`/sessions/${s.id}/start`), `Đã mở buổi ${s.startTime}.`)
              }
            >
              Mở buổi học
            </ActionButton>
          )}
          {canAttend && (
            <Link className="btn secondary small" href={`/tutor/sessions/${s.id}/attendance`}>
              Điểm danh
            </Link>
          )}
          {canMove && (
            <button className="btn secondary small" onClick={() => setPanel('reschedule')}>
              Dời buổi
            </button>
          )}
          {canCancel && (
            <button className="btn secondary small" onClick={() => setPanel('cancel')}>
              Hủy buổi
            </button>
          )}
          {s.status === 'CANCELLED' && (
            <button className="btn secondary small" onClick={() => setPanel('makeup')}>
              Tạo buổi bù
            </button>
          )}
        </div>
      </div>

      {panel === 'cancel' && (
        <form
          className="stack"
          onSubmit={(e) => e.preventDefault()}
          style={{ marginTop: '0.75rem' }}
        >
          <Field label="Lý do hủy">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="hint">Không học sinh nào bị tính phí cho buổi bị hủy (BR-SC-04).</p>
          <div className="row">
            <ActionButton
              variant="danger"
              disabled={!reason.trim()}
              onClick={() =>
                run(
                  () => api.post(`/sessions/${s.id}/cancel`, { reason: reason.trim() }),
                  `Đã hủy buổi ${formatDate(s.date)} ${s.startTime}. Bạn có thể tạo buổi bù ngay bên dưới.`,
                  'makeup',
                )
              }
            >
              Xác nhận hủy
            </ActionButton>
            <button type="button" className="btn secondary" onClick={() => setPanel('none')}>
              Thôi
            </button>
          </div>
        </form>
      )}

      {(panel === 'reschedule' || panel === 'makeup') && (
        <form
          className="stack"
          onSubmit={(e) => e.preventDefault()}
          style={{ marginTop: '0.75rem' }}
        >
          <strong>{panel === 'makeup' ? 'Buổi bù cho buổi đã hủy' : 'Dời sang giờ mới'}</strong>
          <div className="grid">
            <Field label="Ngày mới">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Giờ bắt đầu">
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field label="Giờ kết thúc">
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <ActionButton
              onClick={() =>
                panel === 'makeup'
                  ? run(
                      () =>
                        api.post('/sessions', {
                          classId: s.classId,
                          date,
                          startTime,
                          endTime,
                          makeupOf: s.id,
                        }),
                      `Đã tạo buổi bù ngày ${formatDate(date)} ${startTime}.`,
                    )
                  : run(
                      () => api.post(`/sessions/${s.id}/reschedule`, { date, startTime, endTime }),
                      `Đã dời buổi sang ${formatDate(date)} ${startTime}.`,
                    )
              }
            >
              {panel === 'makeup' ? 'Tạo buổi bù' : 'Lưu giờ mới'}
            </ActionButton>
            <button type="button" className="btn secondary" onClick={() => setPanel('none')}>
              Thôi
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={error} />
      {s.status === 'SCHEDULED' && !canStart && now < startsAt && (
        <p className="hint">
          Mở buổi được từ 15 phút trước giờ học (
          {formatDateTime(new Date(startsAt - START_EARLY_MS).toISOString())}).
        </p>
      )}
    </article>
  );
}

function OneOffSession({
  classes,
  names,
  onCreated,
}: {
  classes: ClassView[];
  names: Map<string, string>;
  onCreated: (message?: string) => void;
}) {
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(addDays(todayVn(), 1));
  const [startTime, setStartTime] = useState('18:00');
  const [endTime, setEndTime] = useState('19:30');
  const [error, setError] = useState('');
  return (
    <section className="card" aria-label="Buổi lẻ" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ marginTop: 0 }}>Tạo buổi lẻ ngoài lịch lặp</h2>
      <form className="row" onSubmit={(e) => e.preventDefault()}>
        <Field label="Lớp">
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">— Chọn lớp —</option>
            {classes
              .filter((c) => c.status === 'OPEN')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Ngày">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Bắt đầu">
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="Kết thúc">
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
        <ActionButton
          type="submit"
          disabled={!classId}
          onClick={async () => {
            setError('');
            try {
              await api.post('/sessions', { classId, date, startTime, endTime });
              onCreated(`Đã tạo buổi lẻ ${formatDate(date)} ${startTime}.`);
            } catch (err) {
              setError(conflictText(err, names));
            }
          }}
        >
          Tạo buổi
        </ActionButton>
      </form>
      <ErrorBox error={error} />
    </section>
  );
}
