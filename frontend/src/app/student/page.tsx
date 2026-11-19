'use client';
import { useAuth } from '@/lib/auth';

export default function Home() {
  const { session } = useAuth();
  return (
    <>
      <h1>Tổng quan học sinh</h1>
      <p className="muted">Xin chào {session?.email}.</p>
    </>
  );
}
