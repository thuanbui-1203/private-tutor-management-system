'use client';
import { AppShell, RoleGate } from '@/components/session';
import { PARENT_NAV } from '@/lib/nav';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={['PARENT']}>
      <AppShell nav={PARENT_NAV}>{children}</AppShell>
    </RoleGate>
  );
}
