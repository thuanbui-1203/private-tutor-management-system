'use client';
import { AppShell, RoleGate } from '@/components/session';
import { ADMIN_NAV } from '@/lib/nav';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={['ADMIN']}>
      <AppShell nav={ADMIN_NAV}>{children}</AppShell>
    </RoleGate>
  );
}
