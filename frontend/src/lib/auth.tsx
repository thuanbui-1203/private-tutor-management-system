'use client';
/**
 * The authentication module (ADR-0004): wraps the Firebase client SDK. It exposes who is
 * signed in, their role and Identity `userId` (custom claims), and the sign-in / sign-up /
 * sign-out / password-reset operations. Everything else asks this module, never Firebase.
 */
import {
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { firebaseAuth } from './firebase';
import type { Role } from './types';

export interface Session {
  uid: string;
  email: string;
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
  signIn(email: string, password: string): Promise<Session>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;
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
    role: (claims.role as Role | undefined) ?? null,
    userId: (claims.userId as string | undefined) ?? null,
  };
}

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
      async signIn(email, password) {
        setSignedOut(false);
        const { user } = await signInWithEmailAndPassword(firebaseAuth(), email, password);
        const s = await sessionOf(user);
        setSession(s);
        return s;
      },
      async signUp(email, password) {
        await createUserWithEmailAndPassword(firebaseAuth(), email, password);
      },
      async signOut() {
        setSignedOut(true);
        await firebaseSignOut(firebaseAuth());
        setSession(null);
      },
      resetPassword: (email) => sendPasswordResetEmail(firebaseAuth(), email),
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
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'Email hoặc mật khẩu không đúng.';
    case 'auth/too-many-requests':
      return 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau ít phút hoặc đặt lại mật khẩu.';
    case 'auth/user-disabled':
      return 'Tài khoản này đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.';
    case 'auth/email-already-in-use':
      return 'Email này đã được dùng cho một tài khoản khác. Hãy đăng nhập.';
    case 'auth/weak-password':
      return 'Mật khẩu quá yếu: cần ít nhất 8 ký tự.';
    case 'auth/network-request-failed':
      return 'Không kết nối được máy chủ đăng nhập. Kiểm tra mạng rồi thử lại.';
    default:
      return 'Không thể đăng nhập lúc này. Vui lòng thử lại.';
  }
}
