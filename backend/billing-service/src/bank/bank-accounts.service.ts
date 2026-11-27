import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { maskAccountNumber, recordChange, type AuthUser, type SqlExecutor } from '@tms/common';
import { z } from 'zod';
import type { BankAccount, Consent, Prisma } from '../generated/prisma/client';
import { StudentClient } from '../invoices/student.client';
import { PrismaService } from '../prisma/prisma.service';
import { BankCipher } from './bank-cipher';
import { VN_BANKS } from './vn-banks';

// Bank details stored only with consent (ADR-0006).

/** Version of the consent text the frontend shows; a new text gets a new version. */
export const BANK_POLICY_VERSION = '2026-11-22';

export const BankAccountInput = z.object({
  bankBin: z
    .string()
    .refine(
      (bin) => VN_BANKS.some((b) => b.bin === bin && b.transfer),
      'not a Vietnamese bank that takes NAPAS 247 transfers (GET /billing/banks)',
    ),
  accountNumber: z.string().regex(/^\d{6,19}$/, 'an account number has 6 to 19 digits'),
  accountName: z.string().trim().min(1).max(100),
  consent: z.literal(true, {
    error: 'bank details are stored only with your consent (consent: true)',
  }),
  policyVersion: z.literal(BANK_POLICY_VERSION, {
    error: `consent must be given to the current policy (${BANK_POLICY_VERSION})`,
  }),
});
export type BankAccountInput = z.infer<typeof BankAccountInput>;

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
type WithConsent = BankAccount & { consent: Consent };

/** What the record says about the stored number: never the number itself. */
const auditable = (a: BankAccount | null) =>
  a && {
    ownerRole: a.ownerRole,
    bankBin: a.bankBin,
    accountNumber: a.accountNumberEnc ? `••••${a.accountLast4}` : null,
    accountName: a.accountName,
    consentId: a.consentId,
    maskedAt: a.maskedAt,
  };

const consentView = (c: Consent) => ({
  policyVersion: c.policyVersion,
  grantedAt: c.grantedAt.toISOString(),
  withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
});

@Injectable()
export class BankAccountsService {
  private readonly cipher = BankCipher.fromEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentClient,
  ) {}

  private requireCipher(): BankCipher {
    if (!this.cipher) {
      throw new ServiceUnavailableException(
        'bank details cannot be stored: BANK_DATA_KEY is not set',
      );
    }
    return this.cipher;
  }

  /** The owner's own view: the number is always masked, even to them. */
  private ownerView(a: WithConsent) {
    return {
      bankBin: a.bankBin,
      accountNumberMasked: maskAccountNumber(a.accountLast4),
      accountName: a.accountName,
      status: a.maskedAt ? ('MASKED' as const) : ('ACTIVE' as const),
      maskedAt: a.maskedAt?.toISOString() ?? null,
      consent: consentView(a.consent),
    };
  }

  /** GET /billing/bank-account */
  async mine(actor: AuthUser) {
    const account = await this.prisma.bankAccount.findUnique({
      where: { ownerId: actor.id },
      include: { consent: true },
    });
    return { policyVersion: BANK_POLICY_VERSION, account: account && this.ownerView(account) };
  }

  /** PUT /billing/bank-account: consent first, then the (encrypted) number. */
  async save(actor: AuthUser, input: BankAccountInput) {
    const cipher = this.requireCipher();
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.bankAccount.findUnique({ where: { ownerId: actor.id } });
      const active = await tx.consent.findFirst({
        where: { userId: actor.id, purpose: 'BANK_ACCOUNT', withdrawnAt: null },
        orderBy: { grantedAt: 'desc' },
      });
      let consent = active;
      if (!consent || consent.policyVersion !== input.policyVersion) {
        if (consent) {
          // Superseded by consent to a newer text.
          await tx.consent.update({ where: { id: consent.id }, data: { withdrawnAt: new Date() } });
        }
        consent = await tx.consent.create({
          data: { userId: actor.id, purpose: 'BANK_ACCOUNT', policyVersion: input.policyVersion },
        });
        await recordChange(exec(tx), {
          action: 'consent.grant',
          entityType: 'Consent',
          entityId: consent.id,
          after: { purpose: consent.purpose, policyVersion: consent.policyVersion },
        });
      }
      const data = {
        ownerRole: actor.role === 'ADMIN' ? 'TUTOR' : actor.role,
        bankBin: input.bankBin,
        accountNumberEnc: cipher.encrypt(input.accountNumber, actor.id),
        accountLast4: input.accountNumber.slice(-4),
        accountName: input.accountName,
        consentId: consent.id,
        maskedAt: null,
      };
      const after = await tx.bankAccount.upsert({
        where: { ownerId: actor.id },
        create: { ownerId: actor.id, ...data },
        update: data,
        include: { consent: true },
      });
      await recordChange(exec(tx), {
        action: 'bank-account.save',
        entityType: 'BankAccount',
        entityId: after.id,
        before: auditable(before),
        after: auditable(after),
      });
      return after;
    });
    return this.ownerView(saved);
  }

  /**
   * DELETE /billing/bank-account/consent: the consent is withdrawn (kept as evidence) and
   * the account masked at once: ciphertext and holder name erased, BIN + last 4 kept.
   */
  async withdraw(actor: AuthUser) {
    const masked = await this.prisma.$transaction(async (tx) => {
      const active = await tx.consent.findMany({
        where: { userId: actor.id, purpose: 'BANK_ACCOUNT', withdrawnAt: null },
      });
      if (active.length === 0)
        throw new NotFoundException('there is no active consent to withdraw');
      const now = new Date();
      for (const c of active) {
        await tx.consent.update({ where: { id: c.id }, data: { withdrawnAt: now } });
        await recordChange(exec(tx), {
          action: 'consent.withdraw',
          entityType: 'Consent',
          entityId: c.id,
          before: { withdrawnAt: null },
          after: { withdrawnAt: now },
        });
      }
      const before = await tx.bankAccount.findUnique({ where: { ownerId: actor.id } });
      if (!before) return null;
      const after = await tx.bankAccount.update({
        where: { ownerId: actor.id },
        data: { accountNumberEnc: null, accountName: null, maskedAt: now },
        include: { consent: true },
      });
      await recordChange(exec(tx), {
        action: 'bank-account.mask',
        entityType: 'BankAccount',
        entityId: after.id,
        before: auditable(before),
        after: auditable(after),
      });
      return after;
    });
    return { policyVersion: BANK_POLICY_VERSION, account: masked && this.ownerView(masked) };
  }

  /**
   * GET /billing/bank-accounts (Tutor, Admin): Payers' accounts, for refunds. The full
   * number only while the Payer's consent is active; masked after withdrawal. A Tutor gets only
   * the Payers of their own Students; when that cannot be checked, nothing is shown (503).
   */
  async payerAccounts(actor: AuthUser) {
    const rows = await this.prisma.bankAccount.findMany({
      where: {
        ownerRole: { in: ['PARENT', 'STUDENT'] },
        ...(actor.role !== 'ADMIN' && { ownerId: { in: await this.payersOf(actor.id) } }),
      },
      include: { consent: true },
      orderBy: { updatedAt: 'desc' },
    });
    const cipher = rows.some((r) => r.accountNumberEnc) ? this.requireCipher() : undefined;
    return rows.map((r) => ({
      ownerId: r.ownerId,
      ownerRole: r.ownerRole,
      bankBin: r.bankBin,
      accountNumber: r.accountNumberEnc ? cipher!.decrypt(r.accountNumberEnc, r.ownerId) : null,
      accountNumberMasked: maskAccountNumber(r.accountLast4),
      accountName: r.accountName,
      status: r.maskedAt ? ('MASKED' as const) : ('ACTIVE' as const),
      consent: consentView(r.consent),
    }));
  }

  private async payersOf(tutorId: string): Promise<string[]> {
    try {
      return await this.students.payersOf(tutorId);
    } catch {
      throw new ServiceUnavailableException('student service unavailable; try again shortly');
    }
  }

  /** VietQR target: the Tutor's own account while their consent is active, else undefined. */
  async transferTarget(tutorId: string) {
    const account = await this.prisma.bankAccount.findUnique({ where: { ownerId: tutorId } });
    if (!account?.accountNumberEnc || account.ownerRole !== 'TUTOR' || !this.cipher)
      return undefined;
    return {
      bankBin: account.bankBin,
      accountNumber: this.cipher.decrypt(account.accountNumberEnc, tutorId),
      accountName: account.accountName,
    };
  }
}
