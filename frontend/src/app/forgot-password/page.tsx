'use client';
/** Firebase's own password-reset email; no backend endpoint is involved. */
import Link from 'next/link';
import { useState } from 'react';
import { ActionButton, ErrorBox, Field, Notice } from '@/components/ui';
import { authErrorMessage, useAuth } from '@/lib/auth';

export default function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    try {
      await resetPassword(email.trim());
      setSent(true);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // Do not reveal whether an account exists for this email.
      if (code === 'auth/user-not-found') setSent(true);
      else setError(authErrorMessage(err));
    }
  }

  return (
    <main className="centered">
      <h1>Quên mật khẩu</h1>
      {sent ? (
        <Notice tone="success">
          Nếu email có trong hệ thống, chúng tôi đã gửi liên kết đặt lại mật khẩu. Hãy kiểm tra hộp
          thư (kể cả thư rác).
        </Notice>
      ) : (
        <form className="card stack" onSubmit={(e) => e.preventDefault()}>
          <Field label="Email đăng nhập">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <ErrorBox error={error} />
          <ActionButton type="submit" onClick={submit} busyLabel="Đang gửi…">
            Gửi liên kết đặt lại
          </ActionButton>
        </form>
      )}
      <p>
        <Link href="/login">Quay lại đăng nhập</Link>
      </p>
    </main>
  );
}
