'use client';
/** The only way in: a Google button. With the Auth emulator it asks which address to be. */
import { useState } from 'react';
import { authErrorMessage, useAuth, type Session } from '@/lib/auth';
import { config } from '@/lib/config';
import { ActionButton, ErrorBox, Field } from './ui';

export function GoogleSignIn({
  label = 'Đăng nhập với Google',
  onSignedIn,
}: {
  label?: string;
  onSignedIn: (session: Session) => Promise<void> | void;
}) {
  const { signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const emulator = config.authEmulatorHost !== '';

  async function submit() {
    setError('');
    let session: Session;
    try {
      session = await signInWithGoogle(email);
    } catch (err) {
      return setError(authErrorMessage(err));
    }
    await onSignedIn(session);
  }

  return (
    <form className="card stack" onSubmit={(e) => e.preventDefault()}>
      {emulator && (
        <Field label="Email" hint="Chế độ giả lập: nhập địa chỉ Google muốn đóng vai">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}
      <ErrorBox error={error} />
      <ActionButton
        type="submit"
        onClick={submit}
        busyLabel="Đang đăng nhập…"
        disabled={emulator && !email.includes('@')}
      >
        {label}
      </ActionButton>
    </form>
  );
}
