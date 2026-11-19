'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ActionButton, ErrorBox, Field, Loading, Notice } from '@/components/ui';
import { authErrorMessage, useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';

const REASONS: Record<string, string> = {
  session:
    'Phiên đăng nhập của bạn đã hết hạn hoặc bị thu hồi (ví dụ tài khoản vừa được đổi vai trò hoặc bị vô hiệu hóa). Vui lòng đăng nhập lại.',
  reset:
    'Nếu email có trong hệ thống, chúng tôi đã gửi liên kết đặt lại mật khẩu. Hãy kiểm tra hộp thư.',
};

function LoginForm() {
  const { signIn } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const reason = REASONS[params.get('reason') ?? ''];

  async function submit() {
    setError('');
    try {
      const s = await signIn(email.trim(), password);
      const next = params.get('next');
      if (!s.role) router.replace('/register?complete=1');
      else router.replace(next?.startsWith('/') ? next : HOME_OF[s.role]);
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  return (
    <main className="centered">
      <h1>Đăng nhập</h1>
      {reason && <Notice tone="warning">{reason}</Notice>}
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <Field label="Email">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Mật khẩu">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <ErrorBox error={error} />
        <ActionButton type="submit" onClick={submit} busyLabel="Đang đăng nhập…">
          Đăng nhập
        </ActionButton>
      </form>
      <p className="row">
        <Link href="/forgot-password">Quên mật khẩu?</Link>
        <span className="muted">·</span>
        <span>
          Giáo viên mới? <Link href="/register">Đăng ký</Link>
        </span>
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<Loading />}>
      <LoginForm />
    </Suspense>
  );
}
