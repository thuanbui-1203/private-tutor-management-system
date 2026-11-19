import { Injectable } from '@nestjs/common';
import { nextPeriod } from '@tms/common';
import type { Invoice, InvoiceStatus, Prisma } from '../generated/prisma/client';
import { NotYetKnownError } from '../copies/copies.service';

type Tx = Prisma.TransactionClient;

/** Day-precision Date for a `YYYY-MM-DD` string (Prisma @db.Date). */
export const day = (date: string) => new Date(`${date}T00:00:00Z`);
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return dateOnly(new Date(Date.UTC(y, m - 1, d + days)));
}
/**
 * BR-BI-07: an issued Invoice's status always follows from its money: fully paid → PAID,
 * otherwise past its due date → OVERDUE, otherwise some money → PARTIALLY_PAID, else ISSUED.
 * DRAFT and VOID are not about money and stay as they are.
 */
export function deriveStatus(
  invoice: Pick<Invoice, 'status' | 'total' | 'dueDate'>,
  paid: number,
  today: string,
): InvoiceStatus {
  if (invoice.status === 'DRAFT' || invoice.status === 'VOID') return invoice.status;
  if (paid >= invoice.total) return 'PAID';
  if (invoice.dueDate && today > dateOnly(invoice.dueDate)) return 'OVERDUE';
  return paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
}

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
   * The Student's DRAFT Monthly invoice that can still take lines for `period`: that period's
   * draft, or (once the period is closed or its invoice issued) the first later open period's,
   * created on demand. Never returns an issued invoice (ADR-0002).
   */
  async openDraft(tx: Tx, studentId: string, period: string): Promise<Invoice> {
    for (let p = period; ; p = nextPeriod(p)) {
      const invoices = await tx.invoice.findMany({
        where: { studentId, period: p, kind: 'MONTHLY' },
      });
      const draft = invoices.find((i) => i.status === 'DRAFT');
      if (draft) return draft;
      if (invoices.some((i) => i.status !== 'VOID')) continue; // issued (or its replacement)
      if (await tx.periodClose.findUnique({ where: { period: p } })) continue;
      return this.createDraft(tx, studentId, p);
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

  /** Net money received for an Invoice: PAYMENTs minus REVERSALs. */
  async paidOf(tx: Tx | { payment: Tx['payment'] }, invoiceId: string): Promise<number> {
    const rows = await tx.payment.groupBy({
      by: ['kind'],
      where: { invoiceId },
      _sum: { amount: true },
    });
    const sum = (k: string) => rows.find((r) => r.kind === k)?._sum.amount ?? 0;
    return sum('PAYMENT') - sum('REVERSAL');
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
