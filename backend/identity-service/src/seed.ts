/**
 * `pnpm --filter @tms/identity-service seed` (or `pnpm seed` at the root): creates the
 * Admin account, idempotently. Uses the Firebase Auth emulator when
 * FIREBASE_AUTH_EMULATOR_HOST is set (recommended in development), otherwise the real
 * project from FIREBASE_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS.
 */
import 'reflect-metadata';
import { enqueueEvent } from '@tms/common';
import { FirebaseAuthService } from './firebase/firebase-auth.service';
import { PrismaService } from './prisma/prisma.service';

const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@tms.local').toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123';

async function main(): Promise<void> {
  const firebase = new FirebaseAuthService();
  const prisma = new PrismaService();
  try {
    const account = await firebase.auth
      .getUserByEmail(email)
      .catch(() => firebase.auth.createUser({ email, password, emailVerified: true }));

    const admin = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { firebaseUid: account.uid } });
      if (existing) {
        return tx.user.update({
          where: { id: existing.id },
          data: { role: 'ADMIN', status: 'ACTIVE' },
        });
      }
      const created = await tx.user.create({
        data: { firebaseUid: account.uid, email, role: 'ADMIN', status: 'ACTIVE' },
      });
      await enqueueEvent(tx, 'UserRegistered', { userId: created.id, email, role: 'ADMIN' });
      return created;
    });
    await firebase.setClaims(account.uid, { userId: admin.id, role: 'ADMIN' });

    const target = process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? `emulator ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`
      : `project ${process.env.FIREBASE_PROJECT_ID}`;
    console.log(`Admin ready: ${email} (users.id ${admin.id}) on Firebase ${target}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
