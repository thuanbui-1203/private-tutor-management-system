import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { signInAllowed } from '@tms/common';
import { Id, Role } from '@tms/contracts';

export interface VerifiedToken {
  /** Present once Identity has registered the user (custom claims, ADR-0004). */
  user?: { id: string; role: Role };
}

/**
 * Verifies Firebase ID tokens (signature, expiry, revocation, Google sign-in). Lazy;
 * uses the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set.
 */
export class TokenVerifier {
  private app?: App;

  async verify(idToken: string): Promise<VerifiedToken> {
    if (!this.app) {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      this.app =
        getApps()[0] ??
        initializeApp(
          process.env.FIREBASE_AUTH_EMULATOR_HOST
            ? { projectId }
            : { projectId, credential: applicationDefault() },
        );
    }
    const decoded = await getAuth(this.app).verifyIdToken(idToken, true);
    if (!signInAllowed(decoded)) throw new Error('sign-in provider not allowed');
    const id = Id.safeParse(decoded.userId);
    const role = Role.safeParse(decoded.role);
    return id.success && role.success ? { user: { id: id.data, role: role.data } } : {};
  }
}
