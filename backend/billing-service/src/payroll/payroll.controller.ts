import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles, ZodBody, type AuthUser } from '@tms/common';
import { Id, Period } from '@tms/contracts';
import { z } from 'zod';
import { PAYROLL_CONFIG, signFunding, type PayrollConfig } from './payout-provider';
import { PayrollService } from './payroll.service';
import { WorkService } from './work.service';

const RateInput = z.object({ amount: z.number().int().positive().max(100_000_000) });
const PeriodInput = z.object({ period: Period });
const WorkQuery = z.object({ period: Period, tutorId: Id.optional() });
const FundingInput = z.object({
  transactionId: z.string().min(1).max(100),
  runId: Id,
  amount: z.number().int().positive().max(2_000_000_000),
  timestamp: z.number().int(),
});
const SandboxOutcome = z.object({ outcome: z.enum(['SUCCESS', 'SHORT', 'FAIL']) });

/** Paying Tutors (docs/07 §6). */
@ApiTags('payroll')
@Controller('billing/payroll')
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly work: WorkService,
  ) {}

  @Get('rates')
  @Roles('ADMIN')
  rates() {
    return this.work.rates();
  }

  @Put('rates/:classId')
  @Roles('ADMIN')
  setRate(
    @CurrentUser() actor: AuthUser,
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body(new ZodBody(RateInput)) body: z.infer<typeof RateInput>,
  ) {
    return this.work.setRate(actor, classId, body.amount);
  }

  /** A Tutor's own taught Sessions and what each is worth; an Admin sees everyone's. */
  @Get('work')
  @Roles('TUTOR', 'ADMIN')
  workItems(
    @CurrentUser() actor: AuthUser,
    @Query(new ZodBody(WorkQuery)) q: z.infer<typeof WorkQuery>,
  ) {
    return this.work.list(actor, q);
  }

  @Get('payouts')
  @Roles('TUTOR', 'ADMIN')
  payouts(@CurrentUser() actor: AuthUser) {
    return this.payroll.payoutsOf(actor);
  }

  @Get('preview')
  @Roles('ADMIN')
  preview(@Query(new ZodBody(PeriodInput)) q: z.infer<typeof PeriodInput>) {
    return this.payroll.preview(q.period);
  }

  @Get('runs')
  @Roles('ADMIN')
  runs() {
    return this.payroll.list();
  }

  @Post('runs')
  @Roles('ADMIN')
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodBody(PeriodInput)) body: z.infer<typeof PeriodInput>,
  ) {
    return this.payroll.create(actor, body.period);
  }

  @Get('runs/:id')
  @Roles('ADMIN')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.get(id);
  }

  @Post('runs/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN')
  approve(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.approve(actor, id);
  }

  @Post('runs/:id/pay-link')
  @HttpCode(200)
  @Roles('ADMIN')
  payLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.payLink(id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @Roles('ADMIN')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.cancel(id);
  }

  @Post('runs/:id/payouts/:payoutId/retry')
  @HttpCode(200)
  @Roles('ADMIN')
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ) {
    return this.payroll.retry(id, payoutId);
  }

  /** The payment provider; authenticated by its HMAC signature, not by a user. */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Body(new ZodBody(FundingInput)) body: z.infer<typeof FundingInput>,
    @Headers('x-payroll-signature') signature?: string,
  ) {
    return this.payroll.onFunding(body, signature ?? '');
  }
}

/**
 * The simulated bank the owner's phone opens after scanning the QR. The token in the link is
 * the only credential; it is single-run, expires after 30 minutes and is stored hashed.
 */
@ApiTags('payroll-sandbox')
@Public()
@Controller('billing/sandbox/payments')
export class SandboxPaymentsController {
  constructor(
    private readonly payroll: PayrollService,
    @Inject(PAYROLL_CONFIG) private readonly config: PayrollConfig | null,
  ) {}

  @Get(':token')
  async view(@Param('token') token: string) {
    const run = await this.payroll.byPayToken(token);
    return { period: run.period, total: run.total, received: run.received };
  }

  /** Plays the bank: reports the payment through the same signed webhook a real one would use. */
  @Post(':token')
  @HttpCode(200)
  async pay(
    @Param('token') token: string,
    @Body(new ZodBody(SandboxOutcome)) body: z.infer<typeof SandboxOutcome>,
  ) {
    const run = await this.payroll.byPayToken(token);
    const remaining = run.total - run.received;
    if (run.status !== 'AWAITING_FUNDS' || remaining <= 0) {
      throw new ConflictException('this payroll is already paid');
    }
    if (body.outcome === 'FAIL') return { status: 'FAILED' as const, paid: 0 };
    const amount = body.outcome === 'SHORT' ? Math.max(1, Math.floor(remaining / 2)) : remaining;
    const notice = {
      transactionId: `SBX-${randomUUID()}`,
      runId: run.id,
      amount,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await this.payroll.onFunding(notice, signFunding(notice, this.config!.webhookSecret));
    return { status: amount < remaining ? ('SHORT' as const) : ('PAID' as const), paid: amount };
  }
}
