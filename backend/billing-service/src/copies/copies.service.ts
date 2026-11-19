import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Messaging, todayInVietnam, type SqlExecutor } from '@tms/common';
import type { EventEnvelope } from '@tms/contracts';
import type { FeePolicy, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;
const asTx = (tx: SqlExecutor) => tx as unknown as Tx;
const day = (date: string) => new Date(`${date}T00:00:00Z`);
/** The Vietnam calendar date of a UTC instant (BR-SYS-02). */
const localDate = (iso: string) => todayInVietnam(new Date(iso));

/** Thrown when an event refers to something not copied yet; the consumer retries later. */
export class NotYetKnownError extends Error {}

/**
 * Billing's local copies of Classes (fee history), Students and Sessions, kept from
 * events so that billing never calls another service (docs/02 §8). Every handler runs
 * inside the idempotent consumer's transaction (processed_events), and is also safe to
 * run twice on its own.
 */
@Injectable()
export class CopiesService implements OnModuleInit {
  private readonly logger = new Logger(CopiesService.name);

  constructor(
    private readonly messaging: Messaging,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('ClassCreated', (e, tx) => this.onClass(e, tx));
    await this.messaging.subscribe('ClassUpdated', (e, tx) => this.onClass(e, tx));
    await this.messaging.subscribe('StudentCreated', (e, tx) => this.onStudent(e, tx));
    await this.messaging.subscribe('StudentUpdated', (e, tx) => this.onStudent(e, tx));
    await this.messaging.subscribe('StudentStatusChanged', (e, tx) => this.onStudentStatus(e, tx));
    await this.messaging.subscribe('SessionScheduled', (e, tx) => this.onSessionScheduled(e, tx));
    await this.messaging.subscribe('SessionCancelled', (e, tx) => this.onSessionCancelled(e, tx));
    await this.messaging.subscribe('SessionRescheduled', (e, tx) =>
      this.onSessionRescheduled(e, tx),
    );
  }

  // ---------------------------------------------------------------- Classes

  /** One row per (Class, effectiveFrom): a fee change for next month never touches this month. */
  async onClass(event: EventEnvelope<'ClassCreated' | 'ClassUpdated'>, tx: SqlExecutor) {
    const { classId, effectiveFrom, tutorId, feeType, feeAmount, chargeAbsent } = event.data;
    const values = { tutorId, feeType, feeAmount, chargeAbsent };
    await asTx(tx).feePolicy.upsert({
      where: { classId_effectiveFrom: { classId, effectiveFrom } },
      create: { classId, effectiveFrom, ...values },
      update: values,
    });
  }

  /** The fee in force for `period` (YYYY-MM): the latest row starting at or before it. */
  policyFor(db: Db, classId: string, period: string): Promise<FeePolicy | null> {
    return db.feePolicy.findFirst({
      where: { classId, effectiveFrom: { lte: period } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  // ---------------------------------------------------------------- Students

  async onStudent(event: EventEnvelope<'StudentCreated' | 'StudentUpdated'>, tx: SqlExecutor) {
    const { studentId, tutorId, fullName, payerContact } = event.data;
    const values = { tutorId, fullName, payerContact };
    await asTx(tx).studentSnapshot.upsert({
      where: { studentId },
      create: { studentId, ...values },
      update: values,
    });
  }

  /** BR-BI-09: a DROPPED Student keeps their charges; the status is informational here. */
  async onStudentStatus(event: EventEnvelope<'StudentStatusChanged'>, tx: SqlExecutor) {
    const { studentId, to } = event.data;
    const { count } = await asTx(tx).studentSnapshot.updateMany({
      where: { studentId },
      data: { status: to },
    });
    // Different queues: the status change can overtake StudentCreated. Retry until it lands.
    if (count === 0) throw new NotYetKnownError(`student ${studentId} not copied yet`);
  }

  // ---------------------------------------------------------------- Sessions

  async onSessionScheduled(event: EventEnvelope<'SessionScheduled'>, tx: SqlExecutor) {
    const { sessionId, classId, startAt } = event.data;
    // Never resurrect a Session already cancelled / moved (a redelivered old event).
    await asTx(tx).sessionCalendar.upsert({
      where: { sessionId },
      create: { sessionId, classId, date: day(localDate(startAt)) },
      update: {},
    });
  }

  async onSessionCancelled(event: EventEnvelope<'SessionCancelled'>, tx: SqlExecutor) {
    const { sessionId } = event.data;
    const { count } = await asTx(tx).sessionCalendar.updateMany({
      where: { sessionId },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) throw new NotYetKnownError(`session ${sessionId} not copied yet`);
  }

  /** Old → RESCHEDULED, new → SCHEDULED: the moved Session is counted once. */
  async onSessionRescheduled(event: EventEnvelope<'SessionRescheduled'>, tx: SqlExecutor) {
    const t = asTx(tx);
    const { oldSessionId, newSessionId, classId, newStartAt } = event.data;
    const { count } = await t.sessionCalendar.updateMany({
      where: { sessionId: oldSessionId },
      data: { status: 'RESCHEDULED' },
    });
    if (count === 0) {
      this.logger.warn(`SessionRescheduled: old session ${oldSessionId} was never copied`);
    }
    await t.sessionCalendar.upsert({
      where: { sessionId: newSessionId },
      create: { sessionId: newSessionId, classId, date: day(localDate(newStartAt)) },
      update: {},
    });
  }

  /**
   * Sessions of a Class held (or still planned) between two dates, inclusive. Cancelled and
   * moved-away Sessions do not count; a Makeup or moved-to Session does.
   */
  countSessions(db: Db, classId: string, from: string, to: string): Promise<number> {
    return db.sessionCalendar.count({
      where: { classId, status: 'SCHEDULED', date: { gte: day(from), lte: day(to) } },
    });
  }
}
