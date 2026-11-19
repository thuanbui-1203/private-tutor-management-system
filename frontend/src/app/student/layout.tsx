'use client';
import { FamilyShell } from '@/components/family';
import { RoleGate } from '@/components/session';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate roles={['STUDENT']}>
      <FamilyShell>{children}</FamilyShell>
    </RoleGate>
  );
}
