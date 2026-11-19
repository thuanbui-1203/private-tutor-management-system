'use client';
import { AppShell, RoleGate } from '@/components/session';
import { STUDENT_NAV } from '@/lib/nav';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={['STUDENT']}>
      <AppShell nav={STUDENT_NAV}>{children}</AppShell>
    </RoleGate>
  );
}
