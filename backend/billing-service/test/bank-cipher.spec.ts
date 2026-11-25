import { randomBytes } from 'node:crypto';
import { BANK_POLICY_VERSION, BankAccountsService } from '../src/bank/bank-accounts.service';
import { BankCipher } from '../src/bank/bank-cipher';

const key = randomBytes(32).toString('base64');
const owner = '00000000-0000-4000-8000-000000000001';

describe('BankCipher (ADR-0006)', () => {
  it('round-trips, with a fresh IV each time', () => {
    const cipher = BankCipher.fromEnv(key)!;
    const a = cipher.encrypt('0123456789', owner);
    const b = cipher.encrypt('0123456789', owner);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toBe(b);
    expect(a).not.toContain('0123456789');
    expect(cipher.decrypt(a, owner)).toBe('0123456789');
  });

  it('refuses a ciphertext moved to another owner, or read with another key', () => {
    const sealed = BankCipher.fromEnv(key)!.encrypt('0123456789', owner);
    expect(() =>
      BankCipher.fromEnv(key)!.decrypt(sealed, '00000000-0000-4000-8000-000000000002'),
    ).toThrow();
    expect(() =>
      BankCipher.fromEnv(randomBytes(32).toString('base64'))!.decrypt(sealed, owner),
    ).toThrow();
  });

  it('is unavailable without a 32-byte key', () => {
    expect(BankCipher.fromEnv(undefined)).toBeUndefined();
    expect(BankCipher.fromEnv(randomBytes(16).toString('base64'))).toBeUndefined();
  });

  it('without a key nothing is stored: 503 before touching the database', async () => {
    delete process.env.BANK_DATA_KEY;
    const prisma = { $transaction: jest.fn() };
    const service = new BankAccountsService(prisma as never, {} as never);
    await expect(
      service.save(
        { id: owner, role: 'TUTOR' },
        {
          bankBin: '970436',
          accountNumber: '0123456789',
          accountName: 'A',
          consent: true,
          policyVersion: BANK_POLICY_VERSION,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
