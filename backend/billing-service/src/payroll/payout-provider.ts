import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TransferRequest {
  /** Same key = same transfer: sending it twice never pays twice. */
  idempotencyKey: string;
  bankBin: string;
  accountNumber: string;
  accountName: string | null;
  amount: number;
  description: string;
}

/** A definite answer. An unknown outcome (timeout) must be thrown, never reported as failed. */
export type TransferResult = { ok: true; reference: string } | { ok: false; reason: string };

/**
 * Pays Tutors (docs/07 §6). One bank transfer by the owner can only reach one account, so the
 * split is done here, one transfer per Tutor. A real provider (a payout API) replaces this
 * without touching the payroll rules.
 */
export interface PayoutProvider {
  readonly name: string;
  send(request: TransferRequest): Promise<TransferResult>;
}

/** Moves no real money. Accounts ending in 0000 are refused, to rehearse a failed payout. */
export class SandboxPayoutProvider implements PayoutProvider {
  readonly name = 'sandbox';

  send(request: TransferRequest): Promise<TransferResult> {
    return Promise.resolve(
      request.accountNumber.endsWith('0000')
        ? { ok: false, reason: 'sandbox: the receiving bank refused the account' }
        : { ok: true, reference: `SBX-${request.idempotencyKey}` },
    );
  }
}

export interface PayrollConfig {
  provider: PayoutProvider;
  webhookSecret: string;
  /** Where the owner's phone opens the simulated payment page. */
  publicUrl: string;
}

export const PAYROLL_CONFIG = Symbol('PAYROLL_CONFIG');

/**
 * `PAYOUT_MODE=sandbox` or nothing: without it payrolls can be prepared but not paid.
 * The sandbox marks Tutors as paid with no money moving, so production refuses to start with it.
 */
export function payrollConfig(env: NodeJS.ProcessEnv = process.env): PayrollConfig | null {
  if (!env.PAYOUT_MODE) return null;
  if (env.PAYOUT_MODE !== 'sandbox') {
    throw new Error(`unknown PAYOUT_MODE ${env.PAYOUT_MODE} (only "sandbox" exists)`);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('PAYOUT_MODE=sandbox is not allowed with NODE_ENV=production');
  }
  const secret = env.PAYOUT_WEBHOOK_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('PAYOUT_MODE=sandbox needs PAYOUT_WEBHOOK_SECRET (32 characters or more)');
  }
  return {
    provider: new SandboxPayoutProvider(),
    webhookSecret: secret,
    publicUrl: (env.SANDBOX_PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, ''),
  };
}

/** The owner's payment as the provider reports it. */
export interface FundingNotice {
  transactionId: string;
  runId: string;
  amount: number;
  /** Unix seconds; notices older than 5 minutes are refused (replay). */
  timestamp: number;
}

export function signFunding(n: FundingNotice, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${n.timestamp}.${n.transactionId}.${n.runId}.${n.amount}`)
    .digest('hex');
}

export function validFunding(
  n: FundingNotice,
  signature: string,
  secret: string,
  now: Date,
): boolean {
  if (Math.abs(now.getTime() / 1000 - n.timestamp) > 300) return false;
  const expected = Buffer.from(signFunding(n, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const newPayToken = () => randomBytes(24).toString('base64url');
