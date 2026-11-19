'use client';
import { AppShell, RoleGate } from '@/components/session';
import { useAuth } from '@/lib/auth';
import { ADMIN_NAV, TUTOR_NAV } from '@/lib/nav';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  return (
    <RoleGate roles={['TUTOR', 'ADMIN']}>
      <AppShell nav={session?.role === 'ADMIN' ? ADMIN_NAV : TUTOR_NAV}>{children}</AppShell>
    </RoleGate>
  );
}
