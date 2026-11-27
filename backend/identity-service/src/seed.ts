/**
 * `pnpm --filter @tms/identity-service seed` (or `pnpm seed` at the root): creates the Admin,
 * idempotently. No Firebase account and no password: the Admin signs in with Google as this
 * e-mail, and the first sign-in is matched to this user (POST /auth/register).
 */
import 'reflect-metadata';
import { enqueueEvent } from '@tms/common';
import { PrismaService } from './prisma/prisma.service';

const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();

async function main(): Promise<void> {
  if (!email) throw new Error('set SEED_ADMIN_EMAIL to the Google address of the Admin');
  const prisma = new PrismaService();
  try {
    const admin = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        return tx.user.update({
          where: { id: existing.id },
          data: { role: 'ADMIN', status: 'ACTIVE' },
        });
      }
      const created = await tx.user.create({ data: { email, role: 'ADMIN', status: 'ACTIVE' } });
      await enqueueEvent(tx, 'UserRegistered', { userId: created.id, email, role: 'ADMIN' });
      return created;
    });
    console.log(`Admin ready (users.id ${admin.id}): sign in with Google as ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
