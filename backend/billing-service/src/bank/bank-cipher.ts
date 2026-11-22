import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for bank account numbers (ADR-0006). The key (`BANK_DATA_KEY`, 32 bytes in
 * base64) lives outside the database. The owner id is authenticated data, so a ciphertext
 * copied onto another user's row fails to decrypt.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export class BankCipher {
  private constructor(private readonly key: Buffer) {}

  /** undefined when BANK_DATA_KEY is missing or not 32 bytes: then nothing can be stored. */
  static fromEnv(value = process.env.BANK_DATA_KEY): BankCipher | undefined {
    if (!value) return undefined;
    const key = Buffer.from(value, 'base64');
    return key.length === 32 ? new BankCipher(key) : undefined;
  }

  encrypt(plain: string, ownerId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(ownerId));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url'));
    return ['v1', ...parts].join('.');
  }

  decrypt(sealed: string, ownerId: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('unknown ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(ownerId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
