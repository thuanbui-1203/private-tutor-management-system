import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  enqueueEvent,
  Messaging,
  nextPeriod,
  periodOf,
  todayInVietnam,
  type SqlExecutor,
} from '@tms/common';
import type { EventEnvelope } from '@tms/contracts';
import type { Prisma } from '../generated/prisma/client';
import { ChargesService } from '../charges/charges.service';
import { CopiesService, NotYetKnownError } from '../copies/copies.service';
import { addDays, dateOnly, day, lastDayOf, LedgerService } from '../invoices/ledger.service';

type Tx = Prisma.TransactionClient;
const asTx = (tx: SqlExecutor) => tx as unknown as Tx;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
/** BR-BI-06 / BR-CL-07: an Enrollment invoice is due 7 days after it is issued. */
export const ENROLLMENT_DUE_DAYS = 7;
const monthLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/**
 * The Billing half of the enrollment Saga (diagram 07): the copy of each Enrollment, the
 * Enrollment invoice for Monthly-fee Classes (BR-BI-06), and the credit when a Student
 * leaves a month they had paid for in advance (BR-BI-05).
 */
@Injectable()
export class EnrollmentsService implements OnModuleInit {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly messaging: Messaging,
    private readonly copies: CopiesService,
    private readonly charges: ChargesService,
    private readonly ledger: LedgerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('StudentEnrolled', (e, tx) => this.onEnrolled(e, asTx(tx)));
    await this.messaging.subscribe('StudentWithdrawn', (e, tx) => this.onWithdrawn(e, asTx(tx)));
  }

  /**
   * Copies the Enrollment; for a Monthly-fee Class also issues the Enrollment invoice at once:
   * the first month prorated by Sessions from the join date, due in 7 days. When nothing is
   * left to teach that month (joined after its last Session), it bills the next month in full.
   * Per-session Classes get no Enrollment invoice.
   */
  async onEnrolled(event: EventEnvelope<'StudentEnrolled'>, tx: Tx): Promise<void> {
    const { enrollmentId, classId, studentId, feeType, joinedAt } = event.data;
    await tx.enrollmentCopy.upsert({
      where: { enrollmentId },
      create: { enrollmentId, classId, studentId, feeType, joinedAt: day(joinedAt) },
      update: {},
    });
    if (feeType !== 'MONTHLY') return;

    await this.ledger.lockStudent(tx, studentId);
    const existing = await tx.invoice.findFirst({
      where: { enrollmentId, kind: 'ENROLLMENT', status: { not: 'VOID' } },
    });
    if (existing) return;
    const student = await tx.studentSnapshot.findUnique({ where: { studentId } });
    if (!student) throw new NotYetKnownError(`student ${studentId} not copied yet`);

    let period = periodOf(joinedAt);
    let policy = await this.copies.policyFor(tx, classId, period);
    if (!policy) throw new NotYetKnownError(`class ${classId} has no fee for ${period} yet`);
    let amount = await this.charges.prorate(
      tx,
      classId,
      policy.feeAmount,
      period,
      joinedAt,
      lastDayOf(period),
    );
    if (amount.value <= 0) {
      period = nextPeriod(period);
      policy = (await this.copies.policyFor(tx, classId, period)) ?? policy;
      amount = { value: policy.feeAmount, note: '' };
    }

    const issuedOn = todayInVietnam(new Date(event.occurredAt));
    const dueDate = addDays(issuedOn, ENROLLMENT_DUE_DAYS);
    const invoice = await tx.invoice.create({
      data: {
        kind: 'ENROLLMENT',
        studentId,
        tutorId: student.tutorId,
        enrollmentId,
        studentName: student.fullName,
        payerContact: student.payerContact as Prisma.InputJsonValue,
        period,
        total: amount.value,
        status: 'ISSUED',
        issuedAt: new Date(event.occurredAt),
        dueDate: day(dueDate),
        items: {
          create: {
            type: 'FEE',
            studentId,
            tutorId: policy.tutorId,
            classId,
            enrollmentId,
            servicePeriod: period,
            amount: amount.value,
            description: `Học phí tháng ${monthLabel(period)}${amount.note} (ghi danh)`,
          },
        },
      },
    });
    await enqueueEvent(exec(tx), 'InvoiceIssued', {
      invoiceId: invoice.id,
      kind: 'ENROLLMENT',
      studentId,
      enrollmentId,
      period,
      total: amount.value,
      dueDate,
    });
  }

  /**
   * The Student is no longer enrolled from the (Vietnam) day of the withdrawal. The Enrollment
   * invoice is never edited or deleted, whatever the reason (UNPAID included): if it billed
   * Sessions the Student can no longer attend, the difference is a negative ADJUSTMENT on the
   * Student's next DRAFT invoice (BR-BI-05; no cash refunds).
   */
  async onWithdrawn(event: EventEnvelope<'StudentWithdrawn'>, tx: Tx): Promise<void> {
    const { enrollmentId, studentId } = event.data;
    const leftOn = todayInVietnam(new Date(event.occurredAt));
    await tx.enrollmentCopy.updateMany({
      where: { enrollmentId, leftAt: null },
      data: { leftAt: day(leftOn) },
    });
    const copy = await tx.enrollmentCopy.findUnique({ where: { enrollmentId } });
    if (!copy || copy.feeType !== 'MONTHLY') return;

    await this.ledger.lockStudent(tx, studentId);
    const fee = await tx.invoiceItem.findFirst({
      where: {
        enrollmentId,
        type: 'FEE',
        superseded: false,
        invoice: { kind: 'ENROLLMENT' },
      },
    });
    if (!fee) return;
    const period = fee.servicePeriod;
    const leftAt = dateOnly(copy.leftAt!);

    const joined = dateOnly(copy.joinedAt);
    const from = joined > `${period}-01` ? joined : `${period}-01`;
    const policy = await this.copies.policyFor(tx, copy.classId, period);
    const fair = policy
      ? (
          await this.charges.prorate(
            tx,
            copy.classId,
            policy.feeAmount,
            period,
            from,
            addDays(leftAt, -1),
          )
        ).value
      : 0;
    // Never credit more than was billed, and count earlier credits for this month.
    const { _sum } = await tx.invoiceItem.aggregate({
      where: {
        enrollmentId,
        servicePeriod: period,
        superseded: false,
      },
      _sum: { amount: true },
    });
    const billed = _sum.amount ?? 0;
    const delta = Math.min(fair, fee.amount) - billed;
    if (delta >= 0) return;
    const draft = await this.ledger.openDraft(tx, studentId, period);
    await tx.invoiceItem.create({
      data: {
        invoiceId: draft.id,
        type: 'ADJUSTMENT',
        studentId,
        tutorId: fee.tutorId,
        classId: copy.classId,
        enrollmentId,
        adjustsItemId: fee.id,
        servicePeriod: period,
        amount: delta,
        description: `Hoàn phần học phí tháng ${monthLabel(period)} chưa học (rời lớp ${leftAt.slice(8, 10)}/${leftAt.slice(5, 7)})`,
      },
    });
    await this.ledger.refreshTotal(tx, draft.id);
    this.logger.log(`enrollment ${enrollmentId}: credit ${delta} for ${period}`);
  }
}
