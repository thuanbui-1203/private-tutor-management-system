'use client';
import { AppShell, RoleGate } from '@/components/session';
import { TUTOR_NAV } from '@/lib/nav';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={['TUTOR', 'ADMIN']}>
      <AppShell nav={TUTOR_NAV}>{children}</AppShell>
    </RoleGate>
  );
}
