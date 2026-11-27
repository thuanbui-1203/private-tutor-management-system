'use client';
/** Sends each user to their role's home, or to sign in / finish signing up. */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';

export default function Home() {
  const { session, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!session || !session.emailVerified) router.replace('/login');
    else if (!session.role) router.replace('/register?complete=1');
    else router.replace(HOME_OF[session.role]);
  }, [loading, session, router]);
  return (
    <main className="centered">
      <Loading />
    </main>
  );
}
