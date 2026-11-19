'use client';
/**
 * Parent and Student screens share this: which Student is being looked at (a Parent may have
 * several children, a Student only themselves) and whether the viewer is that Student's
 * Payer. Billing is shown only when the API says so (student-service sends `payer` only to
 * whoever may see fees), never guessed from the Student's age (BR-ST-05, BR-ST-06).
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { createContext, useContext, useMemo, useState } from 'react';
import { InvoiceBadge, SessionBadge } from '@/components/badges';
import { AppShell, type NavItem } from '@/components/session';
import { AttendanceHistoryView } from '@/components/attendance-history';
import { InvoiceDetail } from '@/components/invoice';
import { DateText, Empty, ErrorBox, Field, Loaded, Loading, Money, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDays, formatDate, formatPeriod, todayVn, weekdayOf } from '@/lib/format';
import { INVOICE_KIND_LABEL } from '@/lib/labels';
import type {
  BalanceView,
  InvoiceView,
  SessionView,
  StudentClassView,
  StudentView,
} from '@/lib/types';

interface Family {
  /** Everyone the viewer may look at (one entry for a Student). */
  students: StudentView[];
  current: StudentView;
  select(id: string): void;
  /** Whether the viewer receives and settles `current`'s Invoices. */
  isPayer: boolean;
  /** `/parent` or `/student`. */
  base: string;
}

const FamilyContext = createContext<Family | null>(null);
const SELECTED_KEY = 'tms.selectedChild';

export function useFamily(): Family {
  const ctx = useContext(FamilyContext);
  if (!ctx) throw new Error('useFamily outside <FamilyShell>');
  return ctx;
}

function readSelected(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

/** Loads the viewer's Student(s), then renders the menu (billing only for the Payer). */
export function FamilyShell({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const isParent = session?.role === 'PARENT';
  const base = isParent ? '/parent' : '/student';
  const list = useLoad(
    () =>
      isParent
        ? api.get<StudentView[]>('/parents/me/children')
        : api.get<StudentView>('/students/me').then((s) => [s]),
    [isParent],
  );
  // Screens render only after the list loads in the browser, so reading storage here is safe.
  const [selected, setSelected] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readSelected(),
  );

  const family = useMemo<Family | null>(() => {
    const students = list.data ?? [];
    if (students.length === 0) return null;
    const current = students.find((s) => s.id === selected) ?? students[0];
    return {
      students,
      current,
      base,
      isPayer: isParent ? current.payer === 'PRIMARY_PARENT' : current.payer === 'SELF',
      select(id) {
        setSelected(id);
        try {
          window.localStorage.setItem(SELECTED_KEY, id);
        } catch {
          // private mode: the choice just is not remembered
        }
      },
    };
  }, [list.data, selected, base, isParent]);

  const nav: NavItem[] = [
    { href: base, label: 'Lịch học' },
    { href: `${base}/attendance`, label: 'Chuyên cần' },
    ...(family?.isPayer ? [{ href: `${base}/billing`, label: 'Học phí' }] : []),
  ];

  return (
    <AppShell nav={nav}>
      {list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !family ? (
        <Empty>
          {isParent
            ? 'Tài khoản chưa được liên kết với học sinh nào. Hãy liên hệ giáo viên.'
            : 'Tài khoản chưa được liên kết với hồ sơ học sinh. Hãy liên hệ giáo viên.'}
        </Empty>
      ) : (
        <FamilyContext.Provider value={family}>
          {family.students.length > 1 && <ChildSwitcher />}
          {children}
        </FamilyContext.Provider>
      )}
    </AppShell>
  );
}

function ChildSwitcher() {
  const { students, current, select } = useFamily();
  return (
    <div className="row" style={{ marginBottom: '0.75rem' }}>
      <Field label="Đang xem">
        <select value={current.id} onChange={(e) => select(e.target.value)}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** The current Student's Classes, as a classId → name map. */
export function useClassNames(studentId: string) {
  const classes = useLoad(
    () => api.get<StudentClassView[]>(`/students/${studentId}/classes`),
    [studentId],
  );
  return useMemo(
    () => new Map((classes.data ?? []).map((c) => [c.class.id, c.class.name])),
    [classes.data],
  );
}

/** Upcoming Sessions for 4 weeks, with cancelled and moved ones clearly marked. */
export function UpcomingSessions() {
  const { current } = useFamily();
  const names = useClassNames(current.id);
  const from = todayVn();
  const sessions = useLoad(
    () =>
      api.get<SessionView[]>('/sessions', { studentId: current.id, from, to: addDays(from, 28) }),
    [current.id],
  );
  return (
    <section aria-label="Lịch học sắp tới">
      <h1>Lịch học của {current.fullName}</h1>
      <Loaded state={sessions}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Không có buổi học nào trong 4 tuần tới.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ngày</th>
                    <th>Giờ</th>
                    <th>Lớp</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {weekdayOf(s.date)}, {formatDate(s.date)}
                      </td>
                      <td>
                        {s.startTime}–{s.endTime}
                      </td>
                      <td>{names.get(s.classId) ?? '—'}</td>
                      <td>
                        <SessionBadge status={s.status} />
                        {s.status === 'CANCELLED' && s.cancelReason && (
                          <div className="hint">Lý do: {s.cancelReason}</div>
                        )}
                        {s.status === 'RESCHEDULED' && (
                          <div className="hint">Buổi này đã được dời sang giờ khác</div>
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
    </section>
  );
}

/** The Payer's billing page: balance and every issued Invoice of the current Student. */
export function FamilyBilling() {
  const { isPayer } = useFamily();
  // Only the Payer loads anything: others are not even asked for (the API would refuse).
  if (!isPayer) return <Empty>Mục học phí chỉ dành cho người thanh toán của học sinh này.</Empty>;
  return <PayerBilling />;
}

function PayerBilling() {
  const { current, base } = useFamily();
  const balance = useLoad(
    () => api.get<BalanceView>(`/billing/students/${current.id}/balance`),
    [current.id],
  );
  const invoices = useLoad(
    () => api.get<InvoiceView[]>(`/billing/students/${current.id}/invoices`),
    [current.id],
  );
  return (
    <>
      <h1>Học phí của {current.fullName}</h1>
      <Loaded state={balance}>
        {(b) => (
          <p className="row">
            <span>
              Còn phải trả:{' '}
              <b>
                <Money value={b.outstanding} />
              </b>
            </span>
            {b.overdue > 0 && (
              <span className="badge red">
                Quá hạn <Money value={b.overdue} />
              </span>
            )}
          </p>
        )}
      </Loaded>
      <Loaded state={invoices}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Chưa có hóa đơn nào.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Hóa đơn</th>
                    <th>Hạn thanh toán</th>
                    <th>Trạng thái</th>
                    <th className="num">Tổng</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`${base}/invoices/${i.id}`}>
                          {INVOICE_KIND_LABEL[i.kind]} {formatPeriod(i.period)}
                        </Link>
                      </td>
                      <td>{i.dueDate ? <DateText value={i.dueDate} /> : '—'}</td>
                      <td>
                        <InvoiceBadge status={i.status} />
                      </td>
                      <td className="num">
                        <Money value={i.total} />
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
}

/** The current Student's monthly Attendance: only their own records (BR-SC-10). */
export function FamilyAttendance() {
  const { current } = useFamily();
  const names = useClassNames(current.id);
  return (
    <>
      <h1>Chuyên cần của {current.fullName}</h1>
      <AttendanceHistoryView studentId={current.id} classNames={names} />
    </>
  );
}

/** One Invoice, read-only, with VietQR while something is owed. */
export function FamilyInvoice() {
  const { id } = useParams<{ id: string }>();
  const { base } = useFamily();
  const invoice = useLoad(() => api.get<InvoiceView>(`/billing/invoices/${id}`), [id]);
  return (
    <>
      <p>
        <Link href={`${base}/billing`}>← Học phí</Link>
      </p>
      <Loaded state={invoice}>
        {(inv) => (
          <InvoiceDetail invoice={inv} canManage={false} onChanged={() => invoice.reload()} />
        )}
      </Loaded>
    </>
  );
}
