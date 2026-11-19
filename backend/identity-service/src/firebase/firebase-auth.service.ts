import { Injectable } from '@nestjs/common';
import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import type { Role } from '@tms/contracts';

/** The custom claims Identity puts on every Firebase account (ADR-0004). */
export interface TmsClaims {
  /** users.id: the only user id that leaves Identity. */
  userId: string;
  role: Role;
}

/**
 * Thin wrapper over the Firebase Admin SDK. Initialised lazily, so the service and
 * its tests boot without credentials. With FIREBASE_AUTH_EMULATOR_HOST set it talks
 * to the Auth emulator; otherwise it uses GOOGLE_APPLICATION_CREDENTIALS.
 */
@Injectable()
export class FirebaseAuthService {
  private app?: App;

  get auth(): Auth {
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
    return getAuth(this.app);
  }

  /** Verifies signature, expiry and revocation. Throws on any invalid token. */
  verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    return this.auth.verifyIdToken(idToken, true);
  }

  async setClaims(firebaseUid: string, claims: TmsClaims): Promise<void> {
    await this.auth.setCustomUserClaims(firebaseUid, { ...claims });
  }
}
