'use client';
/**
 * The authentication module (ADR-0004): wraps the Firebase client SDK. People sign in with
 * Google, or with an e-mail and password whose address they verified through the link Firebase
 * e-mails (the API refuses an unverified address). It exposes who is signed in, their role and Identity `userId` (custom claims), and
 * the sign-in / sign-out operations. Everything else asks this module, never Firebase.
 */
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onIdTokenChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { config } from './config';
import { firebaseAuth } from './firebase';
import type { Role } from './types';

export interface Session {
  uid: string;
  email: string;
  /** False for a password account whose address is not verified yet: the API refuses it. */
  emailVerified: boolean;
  /** From the `role` claim; null for an account that has not finished signing up. */
  role: Role | null;
  /** Identity users.id from the `userId` claim. */
  userId: string | null;
}

interface AuthApi {
  session: Session | null;
  loading: boolean;
  /** True after the user pressed "sign out" (as opposed to a session that expired). */
  signedOut: boolean;
  /** Google sign-in. `emulatorEmail`: who to be, with the Auth emulator only. */
  signInWithGoogle(emulatorEmail?: string): Promise<Session>;
  signInWithEmail(email: string, password: string): Promise<Session>;
  /** Creates a password account and e-mails the verification link. */
  signUpWithEmail(email: string, password: string): Promise<Session>;
  /** E-mails the verification link again. */
  sendVerification(): Promise<void>;
  /** Reloads the account after the link was opened; the new token carries `email_verified`. */
  checkVerified(): Promise<Session | null>;
  /** E-mails a password reset link (nothing is said about whether the address exists). */
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Force a new ID token so freshly set claims (role after sign-up) are picked up. */
  refreshClaims(): Promise<Session | null>;
  /** A valid ID token for the API (refreshed by Firebase when about to expire). */
  idToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthApi | null>(null);

async function sessionOf(user: User, forceRefresh = false): Promise<Session> {
  const { claims } = await user.getIdTokenResult(forceRefresh);
  return {
    uid: user.uid,
    email: user.email ?? '',
    emailVerified: user.emailVerified,
    role: (claims.role as Role | undefined) ?? null,
    userId: (claims.userId as string | undefined) ?? null,
  };
}

/**
 * With the emulator there is no Google: it accepts an unsigned token for any address, so local
 * work and tests need no real account. The real Firebase refuses such a token.
 */
function google(emulatorEmail?: string) {
  if (config.authEmulatorHost) {
    const email = emulatorEmail?.trim().toLowerCase() ?? '';
    const token = JSON.stringify({ sub: `google-${email}`, email, email_verified: true });
    return signInWithCredential(firebaseAuth(), GoogleAuthProvider.credential(token));
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' }); // shared computers
  return signInWithPopup(firebaseAuth(), provider);
}

/** Where the links in Firebase's e-mails lead back to. */
const backToLogin = () => ({ url: `${window.location.origin}/login` });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(
    () =>
      onIdTokenChanged(firebaseAuth(), async (user) => {
        setSession(user ? await sessionOf(user) : null);
        setLoading(false);
      }),
    [],
  );

  const refreshClaims = useCallback(async () => {
    const user = firebaseAuth().currentUser;
    const next = user ? await sessionOf(user, true) : null;
    setSession(next);
    return next;
  }, []);

  const value = useMemo<AuthApi>(
    () => ({
      session,
      loading,
      signedOut,
      async signInWithGoogle(emulatorEmail) {
        setSignedOut(false);
        const { user } = await google(emulatorEmail);
        const s = await sessionOf(user);
        setSession(s);
        return s;
      },
      async signInWithEmail(email, password) {
        setSignedOut(false);
        const { user } = await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
        const s = await sessionOf(user);
        setSession(s);
        return s;
      },
      async signUpWithEmail(email, password) {
        setSignedOut(false);
        const auth = firebaseAuth();
        const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(user, backToLogin());
        const s = await sessionOf(user);
        setSession(s);
        return s;
      },
      async sendVerification() {
        const user = firebaseAuth().currentUser;
        if (user) await sendEmailVerification(user, backToLogin());
      },
      async checkVerified() {
        const user = firebaseAuth().currentUser;
        if (!user) return null;
        await user.reload();
        const s = await sessionOf(user, true);
        setSession(s);
        return s;
      },
      async resetPassword(email) {
        await sendPasswordResetEmail(firebaseAuth(), email.trim(), backToLogin());
      },
      async signOut() {
        setSignedOut(true);
        await firebaseSignOut(firebaseAuth());
        setSession(null);
      },
      refreshClaims,
      async idToken() {
        return (await firebaseAuth().currentUser?.getIdToken()) ?? null;
      },
    }),
    [session, loading, signedOut, refreshClaims],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside <AuthProvider>');
  return ctx;
}

/** Vietnamese message for a Firebase Auth error code. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Bạn đã đóng cửa sổ đăng nhập Google.';
    case 'auth/popup-blocked':
      return 'Trình duyệt đã chặn cửa sổ đăng nhập Google. Hãy cho phép cửa sổ bật lên rồi thử lại.';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email hoặc mật khẩu không đúng. Nếu bạn đã đăng ký bằng Google, hãy bấm nút Google.';
    case 'auth/email-already-in-use':
      return 'Email này đã có tài khoản. Hãy đăng nhập bằng mật khẩu hoặc bằng Google.';
    case 'auth/weak-password':
      return 'Mật khẩu quá yếu: cần ít nhất 8 ký tự.';
    case 'auth/invalid-email':
      return 'Địa chỉ email không hợp lệ.';
    case 'auth/missing-password':
      return 'Vui lòng nhập mật khẩu.';
    case 'auth/account-exists-with-different-credential':
      return 'Email này đã đăng ký bằng cách khác. Hãy đăng nhập như lần trước (mật khẩu hoặc Google).';
    case 'auth/operation-not-allowed':
      return 'Cách đăng nhập này đang tắt. Vui lòng liên hệ quản trị viên.';
    case 'auth/too-many-requests':
      return 'Có quá nhiều lần đăng nhập. Vui lòng thử lại sau ít phút.';
    case 'auth/user-disabled':
      return 'Tài khoản này đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.';
    case 'auth/network-request-failed':
      return 'Không kết nối được máy chủ đăng nhập. Kiểm tra mạng rồi thử lại.';
    default:
      return 'Không thể đăng nhập lúc này. Vui lòng thử lại.';
  }
}
