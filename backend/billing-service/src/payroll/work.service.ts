import { Injectable } from '@nestjs/common';
import {
  currentPeriod,
  nextPeriod,
  periodOf,
  recordChange,
  todayInVietnam,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import type { AttendanceStatus } from '@tms/contracts';
import type { Prisma, WorkItem } from '../generated/prisma/client';
import { CopiesService, NotYetKnownError } from '../copies/copies.service';
import { dateOnly, day } from '../invoices/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;
export const exec = (tx: Tx) => tx as unknown as SqlExecutor;

/** Advisory lock: changes to work share it, taking items into a run holds it alone. */
const PAYROLL_LOCK = 7061;
export const lockExclusive = (tx: Tx) =>
  tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${PAYROLL_LOCK})`);

/** Effective period of a Class's first rate: before any Session. */
const FROM_THE_START = '2000-01';

/** Attendance can still be corrected this long after the Session (BR-SC-03). */
const editWindowHours = () => Number(process.env.ATTENDANCE_EDIT_WINDOW_HOURS || 48);

/**
 * Sessions dated before this are locked: their Attendance cannot change any more. Billing
 * knows the date of a Session, not its end, so the window is counted from the end of that day.
 */
export const lockedBefore = (now: Date) =>
  day(todayInVietnam(new Date(now.getTime() - editWindowHours() * 3_600_000)));

export interface AttendanceWork {
  sessionId: string;
  studentId: string;
  classId: string;
  /** Local date of the Session. */
  date: string;
  status: AttendanceStatus;
  /** When the event happened: an older one arriving late is ignored. */
  occurredAt: string;
}

export type WorkStatus =
  'NO_RATE' | 'NOT_PAYABLE' | 'WAITING_LOCK' | 'ELIGIBLE' | 'IN_RUN' | 'PAID';

export function workStatus(
  i: Pick<WorkItem, 'amount' | 'kind' | 'date' | 'payoutId'>,
  payout: string | undefined,
  locked: Date,
): WorkStatus {
  if (i.payoutId !== null) return payout === 'PAID' ? 'PAID' : 'IN_RUN';
  if (i.date >= locked) return 'WAITING_LOCK';
  if (i.amount === null) return 'NO_RATE';
  return i.kind === 'WORK' && i.amount === 0 ? 'NOT_PAYABLE' : 'ELIGIBLE';
}

const payFor = (attended: boolean, rate: number | null) =>
  rate === null ? null : attended ? rate : 0;

/**
 * Pay for teaching (docs/07 §6): one WorkItem per Session, worth the Class's rate when at least
 * one Student came (PRESENT or LATE) and nothing when nobody did. Once an item is in a run it
 * is never edited; a later change becomes an ADJUSTMENT for the next run (as ADR-0002).
 */
@Injectable()
export class WorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copies: CopiesService,
  ) {}

  /** AttendanceRecorded / AttendanceCorrected, in the consumer's transaction. */
  async onAttendance(tx: Tx, a: AttendanceWork): Promise<void> {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(${PAYROLL_LOCK})`);
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', a.sessionId);
    await tx.$executeRawUnsafe(
      `INSERT INTO session_attendance (session_id, student_id, status, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::"AttendanceStatus", $4::timestamptz)
       ON CONFLICT (session_id, student_id) DO UPDATE
         SET status = EXCLUDED.status, occurred_at = EXCLUDED.occurred_at
         WHERE session_attendance.occurred_at < EXCLUDED.occurred_at`,
      a.sessionId,
      a.studentId,
      a.status,
      a.occurredAt,
    );
    await this.reconcile(tx, a);
  }

  /** Makes what the Session is worth match its Attendance. Safe to run again. */
  async reconcile(tx: Tx, s: { sessionId: string; classId: string; date: string }): Promise<void> {
    const attended =
      (await tx.sessionAttendance.count({
        where: { sessionId: s.sessionId, status: { in: ['PRESENT', 'LATE'] } },
      })) > 0;
    const items = await tx.workItem.findMany({ where: { sessionId: s.sessionId } });
    const work = items.find((i) => i.kind === 'WORK');

    if (!work) {
      const period = periodOf(s.date);
      const policy = await this.copies.policyFor(tx, s.classId, period);
      if (!policy) throw new NotYetKnownError(`class ${s.classId} is not copied yet`);
      const rate = await this.rateFor(tx, s.classId, period);
      await tx.workItem.create({
        data: {
          kind: 'WORK',
          sessionId: s.sessionId,
          classId: s.classId,
          tutorId: policy.tutorId,
          date: day(s.date),
          period,
          attended,
          rate,
          amount: payFor(attended, rate),
        },
      });
      return;
    }

    if (work.payoutId === null) {
      await tx.workItem.update({
        where: { id: work.id },
        data: { attended, amount: payFor(attended, work.rate) },
      });
      return;
    }

    // Already in a run: the difference goes to the next one.
    const settled = items
      .filter((i) => i.payoutId !== null)
      .reduce((sum, i) => sum + (i.amount ?? 0), 0);
    const delta = (payFor(attended, work.rate) ?? 0) - settled;
    const open = items.find((i) => i.kind === 'ADJUSTMENT' && i.payoutId === null);
    if (delta === 0) {
      if (open) await tx.workItem.delete({ where: { id: open.id } });
    } else if (open) {
      await tx.workItem.update({ where: { id: open.id }, data: { attended, amount: delta } });
    } else {
      await tx.workItem.create({
        data: {
          kind: 'ADJUSTMENT',
          sessionId: work.sessionId,
          classId: work.classId,
          tutorId: work.tutorId,
          date: work.date,
          period: work.period,
          attended,
          rate: work.rate,
          amount: delta,
        },
      });
    }
  }

  // ---------------------------------------------------------------- rates

  private async rateFor(tx: Tx, classId: string, period: string): Promise<number | null> {
    const row = await tx.payRate.findFirst({
      where: { classId, effectiveFrom: { lte: period } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row?.amount ?? null;
  }

  rates() {
    return this.prisma.payRate.findMany({
      orderBy: [{ classId: 'asc' }, { effectiveFrom: 'asc' }],
      select: { classId: true, effectiveFrom: true, amount: true },
    });
  }

  /**
   * The first rate of a Class also covers Sessions already taught without one. Later changes
   * start next month, so they never change what was already taught (as BR-CL-04).
   */
  async setRate(actor: AuthUser, classId: string, amount: number, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await lockExclusive(tx);
      const first = !(await tx.payRate.findFirst({ where: { classId } }));
      const effectiveFrom = first ? FROM_THE_START : nextPeriod(currentPeriod(now));
      const key = { classId_effectiveFrom: { classId, effectiveFrom } };
      const before = await tx.payRate.findUnique({ where: key });
      const saved = await tx.payRate.upsert({
        where: key,
        create: { classId, effectiveFrom, amount, setBy: actor.id },
        update: { amount, setBy: actor.id },
      });
      for (const w of await tx.workItem.findMany({ where: { classId, rate: null } })) {
        const rate = await this.rateFor(tx, classId, w.period);
        await tx.workItem.update({
          where: { id: w.id },
          data: { rate, amount: payFor(w.attended, rate) },
        });
      }
      await recordChange(exec(tx), {
        action: 'pay-rate.set',
        entityType: 'PayRate',
        entityId: classId,
        before,
        after: saved,
      });
      return { classId, effectiveFrom, amount };
    });
  }

  // ---------------------------------------------------------------- views

  /** GET /billing/payroll/work: a Tutor sees their own, an Admin anyone's. */
  async list(actor: AuthUser, q: { period: string; tutorId?: string }, now = new Date()) {
    const items = await this.prisma.workItem.findMany({
      where: {
        period: q.period,
        ...(actor.role === 'ADMIN' ? q.tutorId && { tutorId: q.tutorId } : { tutorId: actor.id }),
      },
      include: { payout: { select: { status: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    const locked = lockedBefore(now);
    return items.map((i) => ({
      id: i.id,
      kind: i.kind,
      sessionId: i.sessionId,
      classId: i.classId,
      tutorId: i.tutorId,
      date: dateOnly(i.date),
      attended: i.attended,
      amount: i.amount,
      status: workStatus(i, i.payout?.status, locked),
    }));
  }
}
