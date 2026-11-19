'use client';
/** Wiring between the auth module, the API client and routing. */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { configureApi } from '@/lib/api';
import { AuthProvider, useAuth } from '@/lib/auth';
import { HOME_OF, ROLE_LABEL } from '@/lib/labels';
import type { Role } from '@/lib/types';
import { Loading } from './ui';

/** Gives the API client the current ID token, and signs out on 401 (revoked or expired). */
function ApiBridge() {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    configureApi({
      idToken: () => auth.idToken(),
      onUnauthorized: () => {
        void auth.signOut().then(() => router.replace('/login?reason=session'));
      },
    });
  }, [auth, router]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ApiBridge />
      {children}
    </AuthProvider>
  );
}

/**
 * Lets only `roles` through. Not signed in → /login; signed in without a role → finish
 * signing up; another role → "no permission". UX only: the gateway and services enforce.
 */
export function RoleGate({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { session, loading, signedOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (loading) return;
    if (!session)
      router.replace(signedOut ? '/login' : `/login?next=${encodeURIComponent(pathname)}`);
    else if (!session.role) router.replace('/register?complete=1');
  }, [loading, session, signedOut, router, pathname]);
  if (loading || !session || !session.role) return <Loading />;
  if (!roles.includes(session.role)) return <Forbidden home={HOME_OF[session.role]} />;
  return <>{children}</>;
}

export function Forbidden({ home }: { home?: string }) {
  return (
    <main className="centered">
      <h1>Bạn không có quyền xem trang này</h1>
      <p>
        Trang này dành cho vai trò khác. Nếu bạn nghĩ đây là nhầm lẫn, hãy liên hệ giáo viên hoặc
        quản trị viên.
      </p>
      <Link className="btn primary" href={home ?? '/'}>
        Về trang của tôi
      </Link>
    </main>
  );
}

export interface NavItem {
  href: string;
  label: string;
}

/** A role's home (`/tutor`) is active only on itself; sections also on their sub-pages. */
const isActive = (pathname: string, href: string) =>
  pathname === href || (href.split('/').length > 2 && pathname.startsWith(`${href}/`));

/** The signed-in layout: header with the user and sign-out, and the role's menu. */
export function AppShell({ nav, children }: { nav: NavItem[]; children: React.ReactNode }) {
  const { session, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          TMS
        </Link>
        <nav aria-label="Menu chính">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={isActive(pathname, n.href) ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="who">
          <span>
            {session?.email}
            {session?.role && <small> · {ROLE_LABEL[session.role]}</small>}
          </span>
          <button
            type="button"
            className="btn secondary small"
            onClick={async () => {
              await signOut();
              router.replace('/login');
            }}
          >
            Đăng xuất
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
