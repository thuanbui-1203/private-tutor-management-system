import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { enqueueEvent, Messaging, todayInVietnam, type SqlExecutor } from '@tms/common';
import type { EventEnvelope } from '@tms/contracts';
import type { Prisma } from '../generated/prisma/client';
import { SchedulesService } from './schedules.service';

type Tx = Prisma.TransactionClient;
const asTx = (tx: SqlExecutor) => tx as unknown as Tx;
const today = () => new Date(`${todayInVietnam()}T00:00:00Z`);

/**
 * Keeps the local Class copy and the Roster in step with class-service, and answers
 * the enrollment Saga (docs/diagrams/07): StudentEnrolled → EnrollmentConfirmed, or
 * EnrollmentSyncFailed when the Class is already closed here.
 */
@Injectable()
export class RosterService implements OnModuleInit {
  private readonly logger = new Logger(RosterService.name);

  constructor(
    private readonly messaging: Messaging,
    private readonly schedules: SchedulesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('ClassCreated', (e, tx) => this.onClass(e, tx));
    await this.messaging.subscribe('ClassUpdated', (e, tx) => this.onClass(e, tx));
    await this.messaging.subscribe('ClassClosed', (e, tx) => this.onClassClosed(e, tx));
    await this.messaging.subscribe('StudentEnrolled', (e, tx) => this.onEnrolled(e, tx));
    await this.messaging.subscribe('StudentWithdrawn', (e, tx) => this.onWithdrawn(e, tx));
  }

  async onClass(event: EventEnvelope<'ClassCreated' | 'ClassUpdated'>, tx: SqlExecutor) {
    const { classId, tutorId } = event.data;
    await asTx(tx).classView.upsert({
      where: { classId },
      create: { classId, tutorId },
      update: { tutorId },
    });
  }

  /** BR-CL-05: future Sessions are cancelled and the Class's Schedules end. */
  async onClassClosed(event: EventEnvelope<'ClassClosed'>, tx: SqlExecutor) {
    const t = asTx(tx);
    const { classId } = event.data;
    await t.classView.updateMany({ where: { classId }, data: { open: false } });
    await t.schedule.updateMany({
      where: { classId, endedAt: null },
      data: { endedAt: new Date() },
    });
    const cls = await t.classView.findUnique({ where: { classId } });
    await this.schedules.cancelFuture(t, { classId }, 'Lớp đã đóng', cls?.tutorId ?? classId);
  }

  async onEnrolled(event: EventEnvelope<'StudentEnrolled'>, tx: SqlExecutor) {
    const t = asTx(tx);
    const { enrollmentId, classId, studentId, studentName, joinedAt } = event.data;
    const cls = await t.classView.findUnique({ where: { classId } });
    if (cls && !cls.open) {
      this.logger.warn(
        `StudentEnrolled for closed class ${classId}: rejecting enrollment ${enrollmentId}`,
      );
      await enqueueEvent(tx, 'EnrollmentSyncFailed', {
        enrollmentId,
        classId,
        studentId,
        error: 'the class is closed',
      });
      return;
    }
    await t.rosterEntry.upsert({
      where: { classId_studentId: { classId, studentId } },
      create: {
        classId,
        studentId,
        enrollmentId,
        studentName,
        joinedAt: new Date(`${joinedAt}T00:00:00Z`),
      },
      update: {
        enrollmentId,
        studentName,
        joinedAt: new Date(`${joinedAt}T00:00:00Z`),
        leftAt: null,
      },
    });
    await enqueueEvent(tx, 'EnrollmentConfirmed', { enrollmentId, classId, studentId });
  }

  /** The Student leaves the Roster from today; past Attendance stays. */
  async onWithdrawn(event: EventEnvelope<'StudentWithdrawn'>, tx: SqlExecutor) {
    const { classId, studentId, enrollmentId } = event.data;
    await asTx(tx).rosterEntry.updateMany({
      where: { classId, studentId, enrollmentId, leftAt: null },
      data: { leftAt: today() },
    });
  }
}
