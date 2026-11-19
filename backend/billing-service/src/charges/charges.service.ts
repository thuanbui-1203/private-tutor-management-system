import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Messaging, periodOf, type SqlExecutor } from '@tms/common';
import type { AttendanceStatus } from '@tms/contracts';
import type { Prisma } from '../generated/prisma/client';
import { CopiesService, NotYetKnownError } from '../copies/copies.service';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly, day, lastDayOf, LedgerService } from '../invoices/ledger.service';

type Tx = Prisma.TransactionClient;
const asTx = (tx: SqlExecutor) => tx as unknown as Tx;

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Có mặt',
  LATE: 'Đi trễ',
  EXCUSED: 'Vắng có phép',
  ABSENT: 'Vắng không phép',
};

/** BR-BI-08 / docs/01 §3.4: EXCUSED is never charged; ABSENT only if the Class says so. */
export function chargeable(status: AttendanceStatus, chargeAbsent: boolean): boolean {
  return status === 'PRESENT' || status === 'LATE' || (status === 'ABSENT' && chargeAbsent);
}

const monthLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;
const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

export interface AttendanceFact {
  sessionId: string;
  studentId: string;
  classId: string;
  /** Local date of the Session. */
  date: string;
  status: AttendanceStatus;
}

/**
 * Charges on the Student's Monthly invoice (docs/01 §3.6, diagram 08, ADR-0002):
 * Per-session charges from Attendance, flat Monthly fees, and Adjustments when a charge
 * that was already issued changes.
 */
@Injectable()
export class ChargesService implements OnModuleInit {
  private readonly logger = new Logger(ChargesService.name);

  constructor(
    private readonly messaging: Messaging,
    private readonly prisma: PrismaService,
    private readonly copies: CopiesService,
    private readonly ledger: LedgerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('AttendanceRecorded', (e, tx) =>
      this.reconcile(asTx(tx), e.data),
    );
    await this.messaging.subscribe('AttendanceCorrected', (e, tx) =>
      this.reconcile(asTx(tx), { ...e.data, status: e.data.newStatus }),
    );
  }

  /**
   * Makes the billed amount for one (Session, Student) match what its Attendance calls for.
   * Idempotent, so a duplicate AttendanceRecorded adds nothing (BR-BI-01):
   * - the FEE line is still on a DRAFT invoice → change (or remove) it in place;
   * - otherwise → bill the difference on the next DRAFT invoice: a FEE line if nothing was
   *   ever billed, else an ADJUSTMENT (may be negative). Issued invoices are never edited.
   */
  async reconcile(tx: Tx, a: AttendanceFact): Promise<void> {
    const period = periodOf(a.date);
    const policy = await this.copies.policyFor(tx, a.classId, period);
    if (!policy) throw new NotYetKnownError(`class ${a.classId} has no fee for ${period} yet`);
    if (policy.feeType === 'MONTHLY') return; // flat monthly fee, Attendance does not matter (BR-BI-05)

    await this.ledger.lockStudent(tx, a.studentId);
    const desired = chargeable(a.status, policy.chargeAbsent) ? policy.feeAmount : 0;
    const lines = await tx.invoiceItem.findMany({
      where: {
        sessionId: a.sessionId,
        studentId: a.studentId,
        invoice: { status: { not: 'VOID' } },
      },
      include: { invoice: true },
    });
    const fee = lines.find((l) => l.type === 'FEE');
    const label = `Buổi ${dayLabel(a.date)} (${STATUS_LABEL[a.status]})`;

    if (fee && fee.invoice.status === 'DRAFT') {
      if (desired === 0) await tx.invoiceItem.delete({ where: { id: fee.id } });
      else
        await tx.invoiceItem.update({
          where: { id: fee.id },
          data: { amount: desired, attendanceStatus: a.status, description: label },
        });
      await this.ledger.refreshTotal(tx, fee.invoiceId);
      return;
    }

    const delta = desired - lines.reduce((sum, l) => sum + l.amount, 0);
    if (delta === 0) return;
    const draft = await this.ledger.openDraft(tx, a.studentId, period);
    const base = {
      invoiceId: draft.id,
      studentId: a.studentId,
      tutorId: policy.tutorId,
      classId: a.classId,
      sessionId: a.sessionId,
      servicePeriod: period,
      attendanceStatus: a.status,
    };
    if (lines.length === 0) {
      // First charge, possibly landing on a later invoice (recorded after the close).
      await tx.invoiceItem.create({
        data: { ...base, type: 'FEE', amount: desired, description: label },
      });
    } else {
      await tx.invoiceItem.create({
        data: {
          ...base,
          type: 'ADJUSTMENT',
          adjustsItemId: fee?.id ?? null,
          amount: delta,
          description: `Điều chỉnh điểm danh buổi ${dayLabel(a.date)}: ${STATUS_LABEL[a.status]}`,
        },
      });
    }
    await this.ledger.refreshTotal(tx, draft.id);
  }

  /**
   * Flat Monthly-fee lines for `period` (BR-BI-05), one per Enrollment, prorated by Session
   * count when the Student joined or left during the month. Skips a month already billed (by
   * the Enrollment invoice, or an earlier run): safe to run again. Returns lines added.
   */
  async addMonthlyFees(period: string): Promise<number> {
    const first = `${period}-01`;
    const last = lastDayOf(period);
    const enrollments = await this.prisma.enrollmentCopy.findMany({
      where: {
        feeType: 'MONTHLY',
        joinedAt: { lte: day(last) },
        OR: [{ leftAt: null }, { leftAt: { gt: day(first) } }],
      },
    });
    let added = 0;
    for (const e of enrollments) {
      const joined = dateOnly(e.joinedAt);
      const from = joined > first ? joined : first;
      const leftBefore = e.leftAt ? dateOnly(new Date(e.leftAt.getTime() - 86_400_000)) : last;
      const to = leftBefore < last ? leftBefore : last;
      if (from > to) continue;
      added += await this.prisma.$transaction(async (tx) => {
        const policy = await this.copies.policyFor(tx, e.classId, period);
        if (!policy || policy.feeType !== 'MONTHLY') return 0;
        await this.ledger.lockStudent(tx, e.studentId);
        const billed = await tx.invoiceItem.findFirst({
          where: { enrollmentId: e.enrollmentId, servicePeriod: period, type: 'FEE' },
        });
        if (billed) return 0;
        const amount = await this.prorate(tx, e.classId, policy.feeAmount, period, from, to);
        if (amount.value <= 0) return 0;
        const draft = await this.ledger.openDraft(tx, e.studentId, period);
        await tx.invoiceItem.create({
          data: {
            invoiceId: draft.id,
            type: 'FEE',
            studentId: e.studentId,
            tutorId: policy.tutorId,
            classId: e.classId,
            enrollmentId: e.enrollmentId,
            servicePeriod: period,
            amount: amount.value,
            description: `Học phí tháng ${monthLabel(period)}${amount.note}`,
          },
        });
        await this.ledger.refreshTotal(tx, draft.id);
        return 1;
      });
    }
    if (added) this.logger.log(`${added} monthly fee line(s) added for ${period}`);
    return added;
  }

  /**
   * The Monthly fee for the days [from, to] of `period`: the whole fee for the whole month,
   * otherwise fee × Sessions in [from, to] / Sessions in the month (BR-BI-05, BR-BI-06).
   */
  async prorate(
    db: Tx | PrismaService,
    classId: string,
    fee: number,
    period: string,
    from: string,
    to: string,
  ): Promise<{ value: number; note: string; sessions?: number; ofSessions?: number }> {
    const first = `${period}-01`;
    const last = lastDayOf(period);
    if (from <= first && to >= last) return { value: fee, note: '' };
    const [part, whole] = await Promise.all([
      this.copies.countSessions(db, classId, from, to),
      this.copies.countSessions(db, classId, first, last),
    ]);
    if (whole === 0) return { value: 0, note: '', sessions: 0, ofSessions: 0 };
    return {
      value: Math.round((fee * part) / whole),
      note: ` (${part}/${whole} buổi)`,
      sessions: part,
      ofSessions: whole,
    };
  }
}
