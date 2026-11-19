'use client';
/**
 * Tutor self-signup: Firebase account → POST /auth/register with the ID token → forced token
 * refresh to pick up the `role = TUTOR` claim → the Tutor home. `?complete=1` is for an
 * account that exists in Firebase but has no role yet (an interrupted signup).
 */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ActionButton, ErrorBox, Field, Loading, Notice } from '@/components/ui';
import { describeError, request } from '@/lib/api';
import { authErrorMessage, useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';

function RegisterForm() {
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const completing = params.get('complete') === '1' && !!auth.session && !auth.session.role;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  async function finish() {
    try {
      await request('POST', '/auth/register');
    } catch (err) {
      setError(
        describeError(err, {
          409: 'Tài khoản này đã được đăng ký. Hãy đăng nhập lại.',
          401: 'Phiên đăng ký không hợp lệ. Hãy đăng nhập lại rồi thử lại.',
        }),
      );
      return;
    }
    const s = await auth.refreshClaims();
    router.replace(s?.role ? HOME_OF[s.role] : '/');
  }

  async function submit() {
    setError('');
    if (password.length < 8) return setError('Mật khẩu cần ít nhất 8 ký tự.');
    if (password !== confirm) return setError('Hai mật khẩu không khớp.');
    try {
      await auth.signUp(email.trim(), password);
    } catch (err) {
      return setError(authErrorMessage(err));
    }
    await finish();
  }

  if (auth.loading) return <Loading />;

  if (completing) {
    return (
      <main className="centered">
        <h1>Hoàn tất đăng ký</h1>
        <Notice tone="info">
          Tài khoản <b>{auth.session?.email}</b> chưa có vai trò. Nếu bạn là giáo viên, hãy hoàn tất
          đăng ký. Nếu bạn là phụ huynh hoặc học sinh, hãy mở liên kết trong email lời mời mà giáo
          viên đã gửi.
        </Notice>
        <ErrorBox error={error} />
        <div className="row">
          <ActionButton onClick={finish}>Tôi là giáo viên – hoàn tất đăng ký</ActionButton>
          <ActionButton
            variant="secondary"
            onClick={async () => {
              await auth.signOut();
              router.replace('/login');
            }}
          >
            Đăng xuất
          </ActionButton>
        </div>
      </main>
    );
  }

  return (
    <main className="centered">
      <h1>Đăng ký tài khoản giáo viên</h1>
      <form className="card stack" onSubmit={(e) => e.preventDefault()}>
        <Field label="Email">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Mật khẩu" hint="Ít nhất 8 ký tự">
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="Nhập lại mật khẩu">
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        <ErrorBox error={error} />
        <ActionButton type="submit" onClick={submit} busyLabel="Đang tạo tài khoản…">
          Đăng ký
        </ActionButton>
      </form>
      <p>
        Đã có tài khoản? <Link href="/login">Đăng nhập</Link>
      </p>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RegisterForm />
    </Suspense>
  );
}
