import { Injectable, UnauthorizedException } from '@nestjs/common';
import { signInAllowed } from '@tms/common';
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

  /** Verifies signature, expiry, revocation and Google sign-in. Throws on any invalid token. */
  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    const decoded = await this.auth.verifyIdToken(idToken, true);
    if (!signInAllowed(decoded)) throw new Error('sign-in provider not allowed');
    return decoded;
  }

  /** The verified token of an `Authorization: Bearer …` header, or 401. */
  async fromHeader(authorization?: string): Promise<DecodedIdToken> {
    const idToken = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!idToken) throw new UnauthorizedException('missing Firebase ID token');
    return this.verifyIdToken(idToken).catch(() => {
      throw new UnauthorizedException('sign in with Google: invalid or revoked ID token');
    });
  }

  async setClaims(firebaseUid: string, claims: TmsClaims): Promise<void> {
    await this.auth.setCustomUserClaims(firebaseUid, { ...claims });
  }

  async setDisabled(firebaseUid: string, disabled: boolean): Promise<void> {
    await this.auth.updateUser(firebaseUid, { disabled });
  }

  /** Invalidates every refresh token; the gateway's checkRevoked then rejects old ID tokens. */
  async revokeSessions(firebaseUid: string): Promise<void> {
    await this.auth.revokeRefreshTokens(firebaseUid);
  }
}
