import { Injectable } from '@nestjs/common';
import { nextPeriod } from '@tms/common';
import type { Invoice, Prisma } from '../generated/prisma/client';
import { NotYetKnownError } from '../copies/copies.service';

type Tx = Prisma.TransactionClient;

/** Day-precision Date for a `YYYY-MM-DD` string (Prisma @db.Date). */
export const day = (date: string) => new Date(`${date}T00:00:00Z`);
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
/** Last calendar day of a `YYYY-MM` period. */
export function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return dateOnly(new Date(Date.UTC(y, m, 0)));
}

/**
 * Low-level invoice bookkeeping shared by charges, Enrollment invoices, the monthly close
 * and payments. Callers run inside a transaction and call `lockStudent` first, so that all
 * money movements of one Student are serialised.
 */
@Injectable()
export class LedgerService {
  /** Serialises billing writes for one Student until the transaction ends. */
  async lockStudent(tx: Tx, studentId: string): Promise<void> {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('billing:' || $1))`,
      studentId,
    );
  }

  /**
   * The Student's DRAFT Monthly invoice that can still take lines for `period`: the one for
   * that period if it is still a draft, otherwise the first later period whose invoice is not
   * issued yet (created on demand). Never returns an issued invoice (ADR-0002).
   */
  async openDraft(tx: Tx, studentId: string, period: string): Promise<Invoice> {
    for (let p = period; ; p = nextPeriod(p)) {
      const existing = await tx.invoice.findFirst({
        where: { studentId, period: p, kind: 'MONTHLY', status: { not: 'VOID' } },
      });
      if (existing?.status === 'DRAFT') return existing;
      if (!existing) return this.createDraft(tx, studentId, p);
    }
  }

  private async createDraft(tx: Tx, studentId: string, period: string): Promise<Invoice> {
    const student = await tx.studentSnapshot.findUnique({ where: { studentId } });
    if (!student) throw new NotYetKnownError(`student ${studentId} not copied yet`);
    return tx.invoice.create({
      data: {
        kind: 'MONTHLY',
        studentId,
        tutorId: student.tutorId,
        studentName: student.fullName,
        payerContact: student.payerContact as Prisma.InputJsonValue,
        period,
      },
    });
  }

  /** Recomputes `total` from the items. */
  async refreshTotal(tx: Tx, invoiceId: string): Promise<number> {
    const { _sum } = await tx.invoiceItem.aggregate({
      where: { invoiceId },
      _sum: { amount: true },
    });
    const total = _sum.amount ?? 0;
    await tx.invoice.update({ where: { id: invoiceId }, data: { total } });
    return total;
  }
}
