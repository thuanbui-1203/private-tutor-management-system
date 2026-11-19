import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  currentPeriod,
  enqueueEvent,
  nextPeriod,
  todayInVietnam,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import { PaymentMethod, Period } from '@tms/contracts';
import { z } from 'zod';
import type { Invoice, Payment, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceAccess } from '../invoices/invoice-access';
import { dateOnly, deriveStatus, LedgerService } from '../invoices/ledger.service';
import { vietQrPayload } from './vietqr';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
/** Statuses that can still take money. */
const PAYABLE = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;

export const PaymentInput = z.object({
  amount: z.number().int().positive(),
  method: PaymentMethod,
  /** When the money was received; defaults to now, never in the future. */
  paidAt: z.iso.datetime().optional(),
  note: z.string().trim().max(500).optional(),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

export const ReversalInput = z.object({ reason: z.string().trim().min(1).max(500) });
export type ReversalInput = z.infer<typeof ReversalInput>;

export const RevenueQuery = z
  .object({ from: Period, to: Period })
  .refine((q) => q.from <= q.to, { message: 'to is before from', path: ['to'] });
export type RevenueQuery = z.infer<typeof RevenueQuery>;

export const paymentView = (p: Payment) => ({
  id: p.id,
  invoiceId: p.invoiceId,
  kind: p.kind,
  reversesPaymentId: p.reversesPaymentId,
  amount: p.amount,
  method: p.method,
  paidAt: p.paidAt.toISOString(),
  recordedBy: p.recordedBy,
  note: p.note,
});

/** Money in (BR-BI-07, ADR-0002): Payments, Reversals, balances, revenue, VietQR. */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly access: InvoiceAccess,
  ) {}

  /**
   * POST /billing/invoices/{id}/payments: never more than what is still owed. The status is
   * recomputed from all Payments; PaymentReceived tells Class (Enrollment activation) and
   * Notification (receipt).
   */
  async record(actor: AuthUser, invoiceId: string, input: PaymentInput, now = new Date()) {
    const found = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    await this.access.check(actor, found);
    const paidAt = input.paidAt ? new Date(input.paidAt) : now;
    if (paidAt > now) throw new UnprocessableEntityException('paidAt cannot be in the future');
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lockStudent(tx, found!.studentId);
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (!PAYABLE.includes(invoice.status as (typeof PAYABLE)[number])) {
        throw new ConflictException(`a ${invoice.status} invoice cannot take payments`);
      }
      const paid = await this.ledger.paidOf(tx, invoiceId);
      const outstanding = invoice.total - paid;
      if (input.amount > outstanding) {
        throw new UnprocessableEntityException({
          message: 'the payment is more than what is still owed (BR-BI-07)',
          outstanding,
        });
      }
      const payment = await tx.payment.create({
        data: {
          invoiceId,
          kind: 'PAYMENT',
          amount: input.amount,
          method: input.method,
          paidAt,
          recordedBy: actor.id,
          note: input.note || null,
        },
      });
      const status = await this.refreshStatus(tx, invoice, now);
      await enqueueEvent(exec(tx), 'PaymentReceived', {
        invoiceId,
        invoiceKind: invoice.kind,
        ...(invoice.enrollmentId && { enrollmentId: invoice.enrollmentId }),
        amount: input.amount,
        method: input.method,
        invoiceStatus: paid + input.amount >= invoice.total ? 'PAID' : 'PARTIALLY_PAID',
      });
      return {
        payment: paymentView(payment),
        invoiceStatus: status,
        outstanding: outstanding - input.amount,
      };
    });
  }

  /** POST /billing/payments/{id}/reversal: cancels a wrongly recorded Payment, once. */
  async reverse(actor: AuthUser, paymentId: string, input: ReversalInput, now = new Date()) {
    const original = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: true },
    });
    if (!original) throw new NotFoundException('payment not found');
    await this.access.check(actor, original.invoice);
    if (original.kind !== 'PAYMENT') throw new ConflictException('a reversal cannot be reversed');
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lockStudent(tx, original.invoice.studentId);
      const already = await tx.payment.findUnique({ where: { reversesPaymentId: paymentId } });
      if (already) throw new ConflictException('this payment has already been reversed');
      const reversal = await tx.payment.create({
        data: {
          invoiceId: original.invoiceId,
          kind: 'REVERSAL',
          reversesPaymentId: paymentId,
          amount: original.amount,
          method: original.method,
          paidAt: now,
          recordedBy: actor.id,
          note: input.reason,
        },
      });
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: original.invoiceId } });
      const status = await this.refreshStatus(tx, invoice, now);
      return { reversal: paymentView(reversal), invoiceStatus: status };
    });
  }

  /** GET /billing/students/{id}/balance: what is still owed, Invoice by Invoice. */
  async balance(actor: AuthUser, studentId: string) {
    const student = await this.prisma.studentSnapshot.findUnique({ where: { studentId } });
    if (!student || !(await this.access.allowed(actor, studentId, student.tutorId))) {
      throw new NotFoundException('student not found');
    }
    const invoices = await this.prisma.invoice.findMany({
      where: { studentId, status: { in: [...PAYABLE] } },
      orderBy: [{ dueDate: 'asc' }, { period: 'asc' }],
    });
    const rows = [];
    for (const i of invoices) {
      const paid = await this.ledger.paidOf(this.prisma, i.id);
      rows.push({
        invoiceId: i.id,
        kind: i.kind,
        period: i.period,
        status: i.status,
        dueDate: i.dueDate ? dateOnly(i.dueDate) : null,
        total: i.total,
        paid,
        outstanding: i.total - paid,
      });
    }
    const draft = await this.prisma.invoice.findFirst({
      where: { studentId, kind: 'MONTHLY', status: 'DRAFT', period: currentPeriod() },
    });
    return {
      studentId,
      studentName: student.fullName,
      outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      overdue: rows.filter((r) => r.status === 'OVERDUE').reduce((s, r) => s + r.outstanding, 0),
      /** This month's charges so far (not owed until the invoice is issued on the 1st). */
      currentMonthDraft: draft?.total ?? 0,
      invoices: rows,
    };
  }

  /**
   * GET /billing/reports/revenue?from=YYYY-MM&to=YYYY-MM. `billed`: lines of issued Invoices by
   * the month they are for; `collected`: Payments minus Reversals by the month received (Vietnam
   * time). A Tutor sees their own lines (`tutor_id`) and their Students' Payments; Admin all.
   */
  async revenue(actor: AuthUser, q: RevenueQuery) {
    const tutor = actor.role === 'TUTOR' ? actor.id : null;
    const billed = await this.prisma.$queryRaw<{ period: string; amount: bigint }[]>`
      SELECT i.service_period AS period, SUM(i.amount)::bigint AS amount
      FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
      WHERE NOT i.superseded AND v.status NOT IN ('DRAFT', 'VOID')
        AND i.service_period BETWEEN ${q.from} AND ${q.to}
        AND (${tutor}::uuid IS NULL OR i.tutor_id = ${tutor}::uuid)
      GROUP BY i.service_period`;
    const from = new Date(`${q.from}-01T00:00:00+07:00`);
    const until = new Date(`${nextPeriod(q.to)}-01T00:00:00+07:00`);
    const collected = await this.prisma.$queryRaw<{ period: string; amount: bigint }[]>`
      SELECT to_char(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS period,
             SUM(CASE WHEN p.kind = 'PAYMENT' THEN p.amount ELSE -p.amount END)::bigint AS amount
      FROM payments p JOIN invoices v ON v.id = p.invoice_id
      WHERE p.paid_at >= ${from} AND p.paid_at < ${until}
        AND (${tutor}::uuid IS NULL OR v.tutor_id = ${tutor}::uuid)
      GROUP BY 1`;
    const months = [];
    for (let p = q.from; p <= q.to; p = nextPeriod(p)) {
      months.push({
        period: p,
        billed: Number(billed.find((r) => r.period === p)?.amount ?? 0),
        collected: Number(collected.find((r) => r.period === p)?.amount ?? 0),
      });
    }
    return {
      from: q.from,
      to: q.to,
      months,
      billed: months.reduce((s, m) => s + m.billed, 0),
      collected: months.reduce((s, m) => s + m.collected, 0),
    };
  }

  /** GET /billing/invoices/{id}/qr: a VietQR (NAPAS 247) payload for what is still owed. */
  async qr(actor: AuthUser, invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    await this.access.check(actor, invoice);
    if (!PAYABLE.includes(invoice!.status as (typeof PAYABLE)[number])) {
      throw new ConflictException(`a ${invoice!.status} invoice cannot be paid`);
    }
    const bankBin = process.env.BILLING_BANK_BIN;
    const accountNumber = process.env.BILLING_BANK_ACCOUNT;
    if (!bankBin || !accountNumber) {
      throw new ServiceUnavailableException('the bank account for transfers is not configured');
    }
    const amount = invoice!.total - (await this.ledger.paidOf(this.prisma, invoiceId));
    const description = `TMS ${invoiceId.slice(0, 8).toUpperCase()}`;
    return {
      invoiceId,
      amount,
      bankBin,
      accountNumber,
      accountName: process.env.BILLING_BANK_ACCOUNT_NAME ?? null,
      description,
      payload: vietQrPayload({ bankBin, accountNumber, amount, description }),
    };
  }

  /** GET /internal/students/{id}/open-invoices (BR-ST-08): Invoices not yet PAID or VOID. */
  async openInvoiceIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.invoice.findMany({
      where: {
        studentId,
        OR: [{ status: { in: [...PAYABLE] } }, { status: 'DRAFT', total: { not: 0 } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  private async refreshStatus(tx: Tx, invoice: Invoice, now: Date) {
    const status = deriveStatus(
      invoice,
      await this.ledger.paidOf(tx, invoice.id),
      todayInVietnam(now),
    );
    if (status !== invoice.status) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status } });
    }
    return status;
  }
}
