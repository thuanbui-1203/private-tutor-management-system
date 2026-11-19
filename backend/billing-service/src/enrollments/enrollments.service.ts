import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Messaging, todayInVietnam, type SqlExecutor } from '@tms/common';
import type { EventEnvelope } from '@tms/contracts';
import type { Prisma } from '../generated/prisma/client';
import { day } from '../invoices/ledger.service';

type Tx = Prisma.TransactionClient;
const asTx = (tx: SqlExecutor) => tx as unknown as Tx;

/** Billing's copy of Enrollments (who is in which Class, from when to when). */
@Injectable()
export class EnrollmentsService implements OnModuleInit {
  constructor(private readonly messaging: Messaging) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('StudentEnrolled', (e, tx) => this.onEnrolled(e, asTx(tx)));
    await this.messaging.subscribe('StudentWithdrawn', (e, tx) => this.onWithdrawn(e, asTx(tx)));
  }

  async onEnrolled(event: EventEnvelope<'StudentEnrolled'>, tx: Tx): Promise<void> {
    const { enrollmentId, classId, studentId, feeType, joinedAt } = event.data;
    await tx.enrollmentCopy.upsert({
      where: { enrollmentId },
      create: { enrollmentId, classId, studentId, feeType, joinedAt: day(joinedAt) },
      update: {},
    });
  }

  /** The Student is no longer enrolled from the (Vietnam) day of the withdrawal. */
  async onWithdrawn(event: EventEnvelope<'StudentWithdrawn'>, tx: Tx): Promise<void> {
    await tx.enrollmentCopy.updateMany({
      where: { enrollmentId: event.data.enrollmentId, leftAt: null },
      data: { leftAt: day(todayInVietnam(new Date(event.occurredAt))) },
    });
  }
}
