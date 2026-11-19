import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  currentPeriod,
  enqueueEvent,
  nextPeriod,
  todayInVietnam,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import { z } from 'zod';
import type { Invoice, Prisma } from '../generated/prisma/client';
import { ChargesService } from '../charges/charges.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceAccess } from './invoice-access';
import { addDays, dateOnly, day, LedgerService } from './ledger.service';
import { invoiceView } from './views';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;

/** BR-BI-03: reminders on due + 1, + 5 and + 10 days. */
export const REMINDER_DAYS = [1, 5, 10] as const;
/** A replacement invoice is due at least this many days after it is issued. */
export const REPLACEMENT_MIN_DAYS = 7;
const dueDay = () => String(Number(process.env.BILLING_INVOICE_DUE_DAY ?? 10)).padStart(2, '0');

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const daysBetween = (from: string, to: string) =>
  Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000);

export const VoidInput = z.object({ reason: z.string().trim().min(1).max(500) });
export type VoidInput = z.infer<typeof VoidInput>;

/** Invoice lifecycle (state diagram in docs/diagrams/09): monthly close, overdue, void-and-replace. */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly charges: ChargesService,
    private readonly access: InvoiceAccess,
  ) {}

  /**
   * 00:00 on the 1st (Asia/Ho_Chi_Minh): close the previous month. Adds the Monthly-fee lines,
   * marks the month closed (later charges go to the next month), then issues every DRAFT
   * Monthly invoice up to that month, due on the 10th; a zero total becomes VOID (BR-BI-02).
   * Safe to run again at any time: it only finishes what is left.
   */
  async closeMonth(now = new Date()) {
    const current = currentPeriod(now);
    const period = previousPeriod(current);
    if (!(await this.prisma.periodClose.findUnique({ where: { period } }))) {
      await this.charges.addMonthlyFees(period);
      await this.prisma.periodClose.upsert({ where: { period }, create: { period }, update: {} });
    }
    const drafts = await this.prisma.invoice.findMany({
      where: { kind: 'MONTHLY', status: 'DRAFT', period: { lte: period } },
      select: { id: true, studentId: true },
    });
    const dueDate = `${current}-${dueDay()}`;
    let issued = 0;
    let voided = 0;
    for (const d of drafts) {
      const outcome = await this.prisma.$transaction((tx) => this.issue(tx, d, dueDate, now));
      if (outcome === 'issued') issued++;
      if (outcome === 'void') voided++;
    }
    if (drafts.length) this.logger.log(`closed ${period}: ${issued} issued, ${voided} void`);
    return { period, issued, voided };
  }

  private async issue(
    tx: Tx,
    d: { id: string; studentId: string },
    dueDate: string,
    now: Date,
  ): Promise<'issued' | 'void' | 'skipped'> {
    await this.ledger.lockStudent(tx, d.studentId);
    const invoice = await tx.invoice.findUnique({ where: { id: d.id } });
    if (invoice?.status !== 'DRAFT') return 'skipped';
    let total = await this.ledger.refreshTotal(tx, invoice.id);
    if (total < 0) {
      // More credit than charges: carry the balance to next month (no cash refunds, BR-BI-05).
      const next = await this.ledger.openDraft(tx, invoice.studentId, nextPeriod(invoice.period));
      const carry = {
        studentId: invoice.studentId,
        tutorId: invoice.tutorId,
        type: 'ADJUSTMENT' as const,
      };
      await tx.invoiceItem.createMany({
        data: [
          {
            ...carry,
            invoiceId: invoice.id,
            servicePeriod: invoice.period,
            amount: -total,
            description: `Chuyển số dư ${-total} sang kỳ ${next.period}`,
          },
          {
            ...carry,
            invoiceId: next.id,
            servicePeriod: invoice.period,
            amount: total,
            description: `Số dư chuyển từ kỳ ${invoice.period}`,
          },
        ],
      });
      await this.ledger.refreshTotal(tx, next.id);
      total = await this.ledger.refreshTotal(tx, invoice.id);
    }
    if (total === 0) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'VOID', voidReason: 'Tổng bằng 0 khi chốt (BR-BI-02)' },
      });
      return 'void';
    }
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'ISSUED', issuedAt: now, dueDate: day(dueDate) },
    });
    await enqueueEvent(exec(tx), 'InvoiceIssued', {
      invoiceId: invoice.id,
      kind: 'MONTHLY',
      studentId: invoice.studentId,
      period: invoice.period,
      total,
      dueDate,
    });
    return 'issued';
  }

  /**
   * Daily from 08:00: unpaid Invoices past their due date become OVERDUE, and InvoiceOverdue
   * goes out on due + 1, + 5 and + 10 days (BR-BI-03), both kinds. Each reminder is sent once;
   * after downtime only the latest one reached is sent.
   */
  async markOverdue(now = new Date()) {
    const today = todayInVietnam(now);
    const late = await this.prisma.invoice.findMany({
      where: {
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
        dueDate: { lt: day(today) },
      },
      select: { id: true, studentId: true },
    });
    let marked = 0;
    let reminders = 0;
    for (const l of late) {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.lockStudent(tx, l.studentId);
        const invoice = await tx.invoice.findUnique({ where: { id: l.id } });
        if (
          !invoice?.dueDate ||
          !['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status)
        ) {
          return;
        }
        if (invoice.status !== 'OVERDUE') {
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'OVERDUE' } });
          marked++;
        }
        const overdueBy = daysBetween(dateOnly(invoice.dueDate), today);
        const sent = new Set(
          (await tx.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })).map(
            (r) => r.daysOverdue,
          ),
        );
        const pending = REMINDER_DAYS.filter((d) => d <= overdueBy && !sent.has(d));
        if (pending.length === 0) return;
        await tx.invoiceReminder.createMany({
          data: pending.map((daysOverdue) => ({ invoiceId: invoice.id, daysOverdue })),
        });
        await enqueueEvent(exec(tx), 'InvoiceOverdue', {
          invoiceId: invoice.id,
          daysOverdue: pending[pending.length - 1],
        });
        reminders++;
      });
    }
    return { marked, reminders };
  }

  /**
   * POST /billing/invoices/{id}/void: voids an issued, unpaid Invoice and issues a replacement
   * (`replaces_invoice_id`) with the same lines and the Student's current name and Payer
   * (BR-BI-04). The voided Invoice is kept; its lines no longer count (`superseded`).
   */
  async voidAndReplace(actor: AuthUser, id: string, input: VoidInput, now = new Date()) {
    const found = await this.prisma.invoice.findUnique({ where: { id } });
    await this.access.check(actor, found);
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lockStudent(tx, found!.studentId);
      const old = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: true } });
      if (old.status === 'DRAFT') {
        throw new ConflictException('a draft is still open: nothing to void');
      }
      if (old.status === 'VOID') throw new ConflictException('the invoice is already void');
      if ((await this.ledger.paidOf(tx, id)) > 0) {
        throw new ConflictException('reverse the payments on this invoice before voiding it');
      }
      const student = await tx.studentSnapshot.findUnique({ where: { studentId: old.studentId } });
      await tx.invoice.update({
        where: { id },
        data: { status: 'VOID', voidReason: input.reason },
      });
      await tx.invoiceItem.updateMany({ where: { invoiceId: id }, data: { superseded: true } });

      const today = todayInVietnam(now);
      const minDue = addDays(today, REPLACEMENT_MIN_DAYS);
      const oldDue = old.dueDate ? dateOnly(old.dueDate) : minDue;
      const dueDate = oldDue > minDue ? oldDue : minDue;
      const replacement: Invoice = await tx.invoice.create({
        data: {
          kind: old.kind,
          studentId: old.studentId,
          tutorId: student?.tutorId ?? old.tutorId,
          enrollmentId: old.enrollmentId,
          studentName: student?.fullName ?? old.studentName,
          payerContact: (student?.payerContact ?? old.payerContact) as Prisma.InputJsonValue,
          period: old.period,
          status: 'ISSUED',
          issuedAt: now,
          dueDate: day(dueDate),
          replacesInvoiceId: id,
          items: {
            create: old.items.map((i) => ({
              type: i.type,
              studentId: i.studentId,
              tutorId: i.tutorId,
              classId: i.classId,
              sessionId: i.sessionId,
              enrollmentId: i.enrollmentId,
              adjustsItemId: i.adjustsItemId,
              servicePeriod: i.servicePeriod,
              attendanceStatus: i.attendanceStatus,
              description: i.description,
              amount: i.amount,
            })),
          },
        },
      });
      const total = await this.ledger.refreshTotal(tx, replacement.id);
      await enqueueEvent(exec(tx), 'InvoiceIssued', {
        invoiceId: replacement.id,
        kind: replacement.kind,
        studentId: replacement.studentId,
        ...(replacement.enrollmentId && { enrollmentId: replacement.enrollmentId }),
        period: replacement.period,
        total,
        dueDate,
      });
      const [voided, issued] = await Promise.all([
        tx.invoice.findUniqueOrThrow({ where: { id } }),
        tx.invoice.findUniqueOrThrow({ where: { id: replacement.id }, include: { items: true } }),
      ]);
      return { voided: invoiceView(voided), replacement: invoiceView(issued) };
    });
  }
}
