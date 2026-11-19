'use client';
/**
 * Accepting an invitation: set a password → POST /auth/invitations/{token}/accept (public)
 * → sign in with the invited email and that password → the role's home.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ErrorBox, Field, Notice } from '@/components/ui';
import { ApiError, describeError, request } from '@/lib/api';
import { authErrorMessage, useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';
import type { Role } from '@/lib/types';

interface Accepted {
  userId: string;
  email: string;
  role: Role;
  status: string;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { signIn } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [dead, setDead] = useState(false);

  async function submit() {
    setError('');
    if (password.length < 8) return setError('Mật khẩu cần ít nhất 8 ký tự.');
    if (password !== confirm) return setError('Hai mật khẩu không khớp.');
    let accepted: Accepted;
    try {
      accepted = (
        await request<Accepted>('POST', `/auth/invitations/${encodeURIComponent(token)}/accept`, {
          body: { password },
          auth: false,
        })
      ).data;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) setDead(true);
      else setError(describeError(err));
      return;
    }
    try {
      const s = await signIn(accepted.email, password);
      router.replace(HOME_OF[s.role ?? accepted.role]);
    } catch (err) {
      setError(authErrorMessage(err));
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
      <p className="muted">
        Đặt mật khẩu để vào hệ thống. Bạn sẽ dùng email nhận lời mời và mật khẩu này để đăng nhập.
      </p>
      <form className="card stack" onSubmit={(e) => e.preventDefault()}>
        <Field label="Mật khẩu mới" hint="Ít nhất 8 ký tự">
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Nhập lại mật khẩu">
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <ErrorBox error={error} />
        <ActionButton type="submit" onClick={submit} busyLabel="Đang kích hoạt…">
          Kích hoạt và đăng nhập
        </ActionButton>
      </form>
    </main>
  );
}
