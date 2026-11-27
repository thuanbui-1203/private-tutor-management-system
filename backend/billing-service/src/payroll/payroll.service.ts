import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { currentPeriod, recordChange, type AuthUser } from '@tms/common';
import { BankAccountsService } from '../bank/bank-accounts.service';
import type { Payout, PayrollRun, WorkItem } from '../generated/prisma/client';
import { dateOnly } from '../invoices/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  newPayToken,
  PAYROLL_CONFIG,
  validFunding,
  type FundingNotice,
  type PayrollConfig,
} from './payout-provider';
import { exec, lockedBefore, lockExclusive, WorkService, type Tx } from './work.service';

const PAY_LINK_TTL_MS = 30 * 60_000;
/** A payout still PROCESSING after this was interrupted: it is sent again with the same key. */
const STALE_MS = 2 * 60_000;
/** PostgreSQL INTEGER; far above any real payroll of one centre. */
const MAX_TOTAL = 2_000_000_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const sum = (items: { amount: number | null }[]) =>
  items.reduce((total, i) => total + (i.amount ?? 0), 0);

export type HeldReason = 'NO_BANK_ACCOUNT' | 'NOTHING_TO_PAY';

const payoutView = (p: Payout) => ({
  id: p.id,
  runId: p.runId,
  tutorId: p.tutorId,
  amount: p.amount,
  status: p.status,
  attempts: p.attempts,
  bankBin: p.bankBin,
  accountNumberMasked: p.accountLast4 ? `••••${p.accountLast4}` : null,
  providerRef: p.providerRef,
  failureReason: p.failureReason,
  paidAt: p.paidAt?.toISOString() ?? null,
});

const runView = (r: PayrollRun & { payouts: Payout[] }) => ({
  id: r.id,
  period: r.period,
  status: r.status,
  total: r.total,
  received: r.received,
  approvedAt: r.approvedAt?.toISOString() ?? null,
  fundedAt: r.fundedAt?.toISOString() ?? null,
  completedAt: r.completedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  payouts: r.payouts.map(payoutView),
});

/**
 * Payroll (docs/07 §6): collect what is owed, take one payment from the owner for the whole
 * run, then split it into one transfer per Tutor, exactly as much as their valid work.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bank: BankAccountsService,
    private readonly work: WorkService,
    @Inject(PAYROLL_CONFIG) private readonly config: PayrollConfig | null,
  ) {}

  private requireConfig(): PayrollConfig {
    if (!this.config) {
      throw new ServiceUnavailableException('paying Tutors is not configured (PAYOUT_MODE)');
    }
    return this.config;
  }

  // ---------------------------------------------------------------- preparing a run

  /** Unpaid, valid, locked work up to `period`, per Tutor. */
  private async collect(db: Tx | PrismaService, period: string, now: Date) {
    const items = await db.workItem.findMany({
      where: {
        payoutId: null,
        amount: { not: null },
        period: { lte: period },
        date: { lt: lockedBefore(now) },
        OR: [{ kind: 'ADJUSTMENT' }, { amount: { gt: 0 } }],
      },
    });
    // A Session that was cancelled or moved is never paid, whatever happened to its Attendance.
    const gone = new Set(
      (
        await db.sessionCalendar.findMany({
          where: {
            sessionId: { in: items.map((i) => i.sessionId) },
            status: { in: ['CANCELLED', 'RESCHEDULED'] },
          },
          select: { sessionId: true },
        })
      ).map((s) => s.sessionId),
    );
    const byTutor = new Map<string, WorkItem[]>();
    for (const i of items) {
      if (gone.has(i.sessionId)) continue;
      byTutor.set(i.tutorId, [...(byTutor.get(i.tutorId) ?? []), i]);
    }
    const payable: { tutorId: string; amount: number; items: WorkItem[] }[] = [];
    const held: { tutorId: string; amount: number; sessions: number; reason: HeldReason }[] = [];
    for (const [tutorId, list] of byTutor) {
      const amount = sum(list);
      const sessions = list.filter((i) => i.kind === 'WORK').length;
      if (amount <= 0) held.push({ tutorId, amount, sessions, reason: 'NOTHING_TO_PAY' });
      else if (!(await this.bank.transferTarget(tutorId)))
        held.push({ tutorId, amount, sessions, reason: 'NO_BANK_ACCOUNT' });
      else payable.push({ tutorId, amount, items: list });
    }
    return { payable, held };
  }

  /** GET /billing/payroll/preview: what a run for `period` would pay, without creating it. */
  async preview(period: string, now = new Date()) {
    const { payable, held } = await this.collect(this.prisma, period, now);
    const withoutRate = await this.prisma.workItem.findMany({
      where: { rate: null, period: { lte: period } },
      distinct: ['classId'],
      select: { classId: true },
    });
    return {
      period,
      total: sum(payable),
      tutors: payable.map((p) => ({
        tutorId: p.tutorId,
        amount: p.amount,
        sessions: p.items.filter((i) => i.kind === 'WORK').length,
      })),
      held,
      classesWithoutRate: withoutRate.map((w) => w.classId),
      canPay: this.config !== null,
    };
  }

  /** POST /billing/payroll/runs: freezes the work into a DRAFT run. */
  async create(actor: AuthUser, period: string, now = new Date()) {
    if (period > currentPeriod(now)) {
      throw new UnprocessableEntityException('a payroll cannot be for a future month');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockExclusive(tx);
      const open = await tx.payrollRun.findFirst({
        where: { status: { in: ['DRAFT', 'AWAITING_FUNDS', 'SETTLING'] } },
      });
      if (open) throw new ConflictException(`payroll ${open.id} is still open (${open.status})`);
      const { payable, held } = await this.collect(tx, period, now);
      const total = sum(payable);
      if (payable.length === 0) {
        throw new UnprocessableEntityException({ message: 'there is nothing to pay', held });
      }
      if (total > MAX_TOTAL) throw new UnprocessableEntityException('the total is too large');
      const run = await tx.payrollRun.create({ data: { period, total, createdBy: actor.id } });
      for (const p of payable) {
        const payout = await tx.payout.create({
          data: { runId: run.id, tutorId: p.tutorId, amount: p.amount },
        });
        await tx.workItem.updateMany({
          where: { id: { in: p.items.map((i) => i.id) } },
          data: { payoutId: payout.id },
        });
      }
      const full = await this.load(tx, run.id);
      await recordChange(exec(tx), {
        action: 'payroll.create',
        entityType: 'PayrollRun',
        entityId: run.id,
        after: { period, total, tutors: payable.length },
      });
      return { ...runView(full), held };
    });
  }

  /** POST …/approve: from here the owner can pay. */
  async approve(actor: AuthUser, id: string, now = new Date()) {
    this.requireConfig();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollRun.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'AWAITING_FUNDS', approvedBy: actor.id, approvedAt: now },
      });
      if (count === 0) await this.refuse(tx, id, 'only a DRAFT payroll can be approved');
      const payUrl = await this.issuePayLink(tx, id, now);
      const full = await this.load(tx, id);
      await recordChange(exec(tx), {
        action: 'payroll.approve',
        entityType: 'PayrollRun',
        entityId: id,
        before: { status: 'DRAFT' },
        after: { status: 'AWAITING_FUNDS', total: full.total },
      });
      return { ...runView(full), payUrl };
    });
  }

  /** POST …/pay-link: a fresh QR; the previous one stops working. */
  async payLink(id: string, now = new Date()) {
    this.requireConfig();
    return this.prisma.$transaction(async (tx) => {
      const run = await this.load(tx, id);
      if (run.status !== 'AWAITING_FUNDS') {
        throw new ConflictException(`the payroll is ${run.status}, it is not waiting for money`);
      }
      return { payUrl: await this.issuePayLink(tx, id, now) };
    });
  }

  private async issuePayLink(tx: Tx, id: string, now: Date) {
    const token = newPayToken();
    await tx.payrollRun.update({
      where: { id },
      data: {
        payTokenHash: hash(token),
        payTokenExpiresAt: new Date(now.getTime() + PAY_LINK_TTL_MS),
      },
    });
    return `${this.requireConfig().publicUrl}/sandbox/pay/${token}`;
  }

  /** POST …/cancel: the work goes back to the pool. Not once any money has arrived. */
  async cancel(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockExclusive(tx);
      const { count } = await tx.payrollRun.updateMany({
        where: { id, status: { in: ['DRAFT', 'AWAITING_FUNDS'] }, received: 0 },
        data: { status: 'CANCELLED', payTokenHash: null },
      });
      if (count === 0) {
        await this.refuse(tx, id, 'a payroll that has received money cannot be cancelled');
      }
      const items = await tx.workItem.findMany({ where: { payout: { runId: id } } });
      const sessionIds = [...new Set(items.map((i) => i.sessionId))];
      // A correction that was waiting for the next run is folded back into what it corrects.
      await tx.workItem.deleteMany({
        where: { sessionId: { in: sessionIds }, kind: 'ADJUSTMENT', payoutId: null },
      });
      await tx.workItem.updateMany({
        where: { payout: { runId: id } },
        data: { payoutId: null },
      });
      for (const i of new Map(items.map((x) => [x.sessionId, x])).values()) {
        await this.work.reconcile(tx, {
          sessionId: i.sessionId,
          classId: i.classId,
          date: dateOnly(i.date),
        });
      }
      await tx.payout.deleteMany({ where: { runId: id } });
      await recordChange(exec(tx), {
        action: 'payroll.cancel',
        entityType: 'PayrollRun',
        entityId: id,
        after: { status: 'CANCELLED' },
      });
      return runView(await this.load(tx, id));
    });
  }

  // ---------------------------------------------------------------- money in

  /** POST /billing/payroll/webhook: the provider says the owner paid. */
  async onFunding(notice: FundingNotice, signature: string, now = new Date()) {
    const { webhookSecret } = this.requireConfig();
    if (!validFunding(notice, signature, webhookSecret, now)) {
      throw new UnauthorizedException('invalid signature');
    }
    const result = await this.fund(notice, now);
    if (result.settle) await this.settle(notice.runId);
    return { received: true, duplicate: result.duplicate };
  }

  /**
   * Records money received, once per transaction id. When the whole total is there the run
   * moves to SETTLING; less keeps it waiting, more is kept on record as a surplus.
   */
  private async fund(n: FundingNotice, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM payroll_runs WHERE id = $1::uuid FOR UPDATE',
        n.runId,
      );
      const run = await tx.payrollRun.findUnique({ where: { id: n.runId } });
      if (!run) throw new NotFoundException('payroll not found');
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO payroll_fundings (transaction_id, run_id, amount, received_at)
         VALUES ($1, $2::uuid, $3, $4::timestamptz) ON CONFLICT DO NOTHING`,
        n.transactionId,
        n.runId,
        n.amount,
        now.toISOString(),
      );
      if (inserted === 0) {
        const seen = await tx.payrollFunding.findUniqueOrThrow({
          where: { transactionId: n.transactionId },
        });
        if (seen.runId !== n.runId || seen.amount !== n.amount) {
          throw new ConflictException('this transaction id was already used for something else');
        }
        return { duplicate: true, settle: false };
      }
      const received = run.received + n.amount;
      const funded = run.status === 'AWAITING_FUNDS' && received >= run.total;
      if (funded) await this.checkSplit(tx, run);
      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          received,
          ...(funded && { status: 'SETTLING', fundedAt: now, payTokenHash: null }),
        },
      });
      await recordChange(exec(tx), {
        action: 'payroll.fund',
        entityType: 'PayrollRun',
        entityId: run.id,
        before: { received: run.received, status: run.status },
        after: {
          received,
          status: funded ? 'SETTLING' : run.status,
          transactionId: n.transactionId,
        },
        actor: 'SYSTEM',
      });
      return { duplicate: false, settle: funded };
    });
  }

  /** The shares must add up to exactly the run's total, and each to exactly its Tutor's work. */
  private async checkSplit(tx: Tx, run: PayrollRun): Promise<void> {
    const payouts = await tx.payout.findMany({
      where: { runId: run.id },
      include: { items: { select: { amount: true, tutorId: true } } },
    });
    const ok =
      sum(payouts) === run.total &&
      payouts.every(
        (p) => sum(p.items) === p.amount && p.items.every((i) => i.tutorId === p.tutorId),
      );
    if (!ok) throw new Error(`payroll ${run.id}: the split does not match its total`);
  }

  // ---------------------------------------------------------------- money out

  /** Sends every payout not sent yet. One Tutor's failure never stops the others. */
  async settle(runId: string, now = new Date()): Promise<void> {
    const stale = new Date(now.getTime() - STALE_MS);
    const due = await this.prisma.payout.findMany({
      where: {
        runId,
        run: { status: { in: ['SETTLING', 'PARTIAL'] } },
        OR: [{ status: 'PENDING' }, { status: 'PROCESSING', claimedAt: { lt: stale } }],
      },
    });
    for (const p of due) {
      try {
        await this.payOne(p, now);
      } catch (err) {
        // Unknown outcome: stays PROCESSING, sent again later with the same key.
        this.logger.error(`payout ${p.id}: ${(err as Error).message}`);
      }
    }
    await this.finish(runId, now);
  }

  private async payOne(p: Payout, now: Date): Promise<void> {
    const { provider } = this.requireConfig();
    // Compare-and-set: two workers never send the same payout at the same time. Resuming an
    // interrupted one keeps the attempt number, so the provider sees the same key.
    const attempts = p.status === 'PROCESSING' ? p.attempts : p.attempts + 1;
    const { count } = await this.prisma.payout.updateMany({
      where: { id: p.id, status: p.status, attempts: p.attempts, claimedAt: p.claimedAt },
      data: { status: 'PROCESSING', attempts, claimedAt: now, failureReason: null },
    });
    if (count === 0) return;
    const target = await this.bank.transferTarget(p.tutorId);
    const result = target
      ? await provider.send({
          idempotencyKey: `${p.id}:${attempts}`,
          ...target,
          amount: p.amount,
          description: `TMS LUONG ${p.id.slice(0, 8).toUpperCase()}`,
        })
      : ({ ok: false, reason: 'the Tutor has no bank account with active consent' } as const);
    await this.prisma.$transaction(async (tx) => {
      const { count: saved } = await tx.payout.updateMany({
        where: { id: p.id, status: 'PROCESSING', attempts },
        data: {
          status: result.ok ? 'PAID' : 'FAILED',
          ...(target && {
            bankBin: target.bankBin,
            accountLast4: target.accountNumber.slice(-4),
          }),
          ...(result.ok
            ? { providerRef: result.reference, paidAt: new Date() }
            : { failureReason: result.reason.slice(0, 300) }),
        },
      });
      if (saved === 0) return;
      await recordChange(exec(tx), {
        action: result.ok ? 'payout.paid' : 'payout.failed',
        entityType: 'Payout',
        entityId: p.id,
        after: { runId: p.runId, tutorId: p.tutorId, amount: p.amount },
        actor: 'SYSTEM',
      });
    });
  }

  private async finish(runId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM payroll_runs WHERE id = $1::uuid FOR UPDATE',
        runId,
      );
      const run = await this.load(tx, runId);
      if (run.status !== 'SETTLING' && run.status !== 'PARTIAL') return;
      const left = run.payouts.filter((p) => p.status !== 'PAID');
      if (left.some((p) => p.status !== 'FAILED')) return; // still being sent
      const status = left.length === 0 ? 'COMPLETED' : 'PARTIAL';
      if (status === run.status) return;
      await tx.payrollRun.update({
        where: { id: runId },
        data: { status, ...(status === 'COMPLETED' && { completedAt: now }) },
      });
      await recordChange(exec(tx), {
        action: 'payroll.finish',
        entityType: 'PayrollRun',
        entityId: runId,
        before: { status: run.status },
        after: { status },
        actor: 'SYSTEM',
      });
    });
  }

  /** POST …/payouts/{id}/retry: after the Tutor fixed their account. */
  async retry(runId: string, payoutId: string, now = new Date()) {
    this.requireConfig();
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId, runId },
      include: { run: true },
    });
    if (!payout) throw new NotFoundException('payout not found');
    if (payout.status !== 'FAILED') {
      throw new ConflictException(`the payout is ${payout.status}, only a FAILED one is retried`);
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payout.updateMany({
        where: { id: payoutId, status: 'FAILED', attempts: payout.attempts },
        data: { status: 'PENDING' },
      });
      if (count === 0) throw new ConflictException('the payout is already being retried');
      await recordChange(exec(tx), {
        action: 'payout.retry',
        entityType: 'Payout',
        entityId: payoutId,
        before: { status: 'FAILED' },
        after: { status: 'PENDING' },
      });
    });
    await this.settle(runId, now);
    return this.get(runId);
  }

  /** Every minute: finish what a restart or a provider timeout interrupted. */
  async resume(now = new Date()): Promise<void> {
    if (!this.config) return;
    const runs = await this.prisma.payrollRun.findMany({
      where: {
        OR: [
          { status: 'SETTLING' },
          {
            status: 'PARTIAL',
            payouts: { some: { status: { in: ['PENDING', 'PROCESSING'] } } },
          },
        ],
      },
      select: { id: true },
    });
    for (const r of runs) await this.settle(r.id, now);
  }

  // ---------------------------------------------------------------- views

  async list() {
    const runs = await this.prisma.payrollRun.findMany({
      include: { payouts: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return runs.map(runView);
  }

  async get(id: string) {
    return runView(await this.load(this.prisma, id));
  }

  /** GET /billing/payroll/payouts: a Tutor's own, once the run is approved. */
  async payoutsOf(actor: AuthUser) {
    const rows = await this.prisma.payout.findMany({
      where: { tutorId: actor.id, run: { status: { notIn: ['DRAFT', 'CANCELLED'] } } },
      include: { run: { select: { period: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((p) => ({ ...payoutView(p), period: p.run.period }));
  }

  /** The run behind a sandbox pay link, or 404 when unknown, replaced or expired. */
  async byPayToken(token: string, now = new Date()) {
    this.requireConfig();
    const run = await this.prisma.payrollRun.findUnique({ where: { payTokenHash: hash(token) } });
    if (!run?.payTokenExpiresAt || run.payTokenExpiresAt < now) {
      throw new NotFoundException('this payment link is unknown or expired');
    }
    return run;
  }

  private async load(db: Tx | PrismaService, id: string) {
    const run = await db.payrollRun.findUnique({
      where: { id },
      include: { payouts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw new NotFoundException('payroll not found');
    return run;
  }

  private async refuse(tx: Tx, id: string, message: string): Promise<never> {
    const run = await this.load(tx, id);
    throw new ConflictException(`${message} (now ${run.status})`);
  }
}
