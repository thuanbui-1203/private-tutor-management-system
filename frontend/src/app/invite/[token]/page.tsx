'use client';
/**
 * Accepting an invitation: sign in with Google as the invited address →
 * POST /auth/invitations/{token}/accept with that ID token → refreshed claims → the role's home.
 * It always asks Google again: someone else may still be signed in on a shared computer.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { GoogleSignIn } from '@/components/google-sign-in';
import { ErrorBox, Notice } from '@/components/ui';
import { ApiError, describeError, request } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';
import type { Role } from '@/lib/types';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [dead, setDead] = useState(false);

  async function accept() {
    setError('');
    try {
      const { data } = await request<{ role: Role }>(
        'POST',
        `/auth/invitations/${encodeURIComponent(token)}/accept`,
      );
      const s = await auth.refreshClaims();
      router.replace(HOME_OF[s?.role ?? data.role]);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) setDead(true);
      else
        setError(
          describeError(err, {
            403: 'Lời mời này dành cho một địa chỉ email khác. Hãy đăng nhập Google bằng đúng email đã nhận lời mời.',
            409: 'Tài khoản Google này đã có vai trò trong hệ thống, không kích hoạt lời mời được.',
          }),
        );
    }
  }

  if (dead) {
    return (
      <main className="centered">
        <h1>Lời mời không còn hiệu lực</h1>
        <Notice tone="warning">
          Liên kết này đã hết hạn (sau 7 ngày), đã được dùng, hoặc đã bị thu hồi vì giáo viên gửi
          lời mời mới. Hãy nhờ giáo viên gửi lại lời mời.
        </Notice>
        <p>
          Đã kích hoạt rồi? <Link href="/login">Đăng nhập</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="centered">
      <h1>Kích hoạt tài khoản</h1>
      <p className="muted">Đăng nhập Google bằng đúng địa chỉ email đã nhận lời mời.</p>
      <GoogleSignIn label="Kích hoạt bằng Google" onSignedIn={accept} />
      <ErrorBox error={error} />
    </main>
  );
}
