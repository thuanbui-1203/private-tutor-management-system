'use client';
/**
 * First sign-in: Google, or e-mail + password with a verified address → choose a role → POST /auth/register with the ID token → forced token
 * refresh to pick up the `role` claim → that role's home. An address in ADMIN_EMAILS becomes an
 * Admin whatever was chosen, and a known address gets its own account back.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SignInPanel } from '@/components/sign-in';
import { ActionButton, ErrorBox, Loading, Notice } from '@/components/ui';
import { ApiError, describeError, request } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { HOME_OF } from '@/lib/labels';

const CHOICES = [
  ['TUTOR', 'Tôi là gia sư'],
  ['STUDENT', 'Tôi là học sinh'],
  ['PARENT', 'Tôi là phụ huynh'],
] as const;

export default function RegisterPage() {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');

  async function choose(role: (typeof CHOICES)[number][0]) {
    setError('');
    try {
      await request('POST', '/auth/register', { body: { role } });
    } catch (err) {
      const invited =
        err instanceof ApiError && (err.body as { code?: string } | null)?.code === 'INVITED';
      setError(
        invited
          ? 'Email này đã được giáo viên mời. Hãy mở liên kết trong email lời mời để kích hoạt.'
          : describeError(err, {
              401: 'Phiên đăng ký không hợp lệ. Hãy đăng nhập lại rồi thử lại.',
              403: 'Tài khoản này đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.',
              409: 'Tài khoản này đã được đăng ký. Hãy đăng xuất rồi đăng nhập lại.',
            }),
      );
      return;
    }
    const s = await auth.refreshClaims();
    router.replace(s?.role ? HOME_OF[s.role] : '/');
  }

  if (auth.loading) return <Loading />;
  if (!auth.session || !auth.session.emailVerified) {
    return (
      <main className="centered">
        <h1>Tạo tài khoản</h1>
        <p className="muted lead">Dùng Google hoặc email bất kỳ. Sau đó bạn chọn vai trò.</p>
        <SignInPanel
          initialMode="signup"
          googleLabel="Tiếp tục với Google"
          onReady={(s) => {
            if (s.role) router.replace(HOME_OF[s.role]);
          }}
        />
        <p className="hint">
          Đã có tài khoản? <Link href="/login">Đăng nhập</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="centered">
      <h1>Hoàn tất đăng ký</h1>
      <Notice tone="info">
        Bạn đang đăng nhập bằng <b>{auth.session.email}</b>. Hãy chọn vai trò. Vai trò không tự đổi
        được sau này.
      </Notice>
      <ErrorBox error={error} />
      <div className="stack">
        {CHOICES.map(([role, label]) => (
          <div key={role}>
            <ActionButton onClick={() => choose(role)}>{label}</ActionButton>
          </div>
        ))}
        <div>
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
      </div>
    </main>
  );
}
