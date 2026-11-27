'use client';
/**
 * The way in (ADR-0004): Google, or an e-mail and password. A password account must open the
 * verification link Firebase e-mails before it can use the app (the API refuses it until then),
 * so this panel holds it on a "check your inbox" step and calls `onReady` only with a session
 * whose address is verified. With the Auth emulator the Google button asks which address to be.
 */
import { useState } from 'react';
import { authErrorMessage, useAuth, type Session } from '@/lib/auth';
import { config } from '@/lib/config';
import { ActionButton, ErrorBox, Field, Notice } from './ui';

type Mode = 'signin' | 'signup' | 'reset';
const MIN_PASSWORD = 8;

export function SignInPanel({
  initialMode = 'signin',
  googleLabel = 'Đăng nhập với Google',
  onReady,
}: {
  initialMode?: 'signin' | 'signup';
  googleLabel?: string;
  onReady: (session: Session) => Promise<void> | void;
}) {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  // A password account that has not opened its verification link yet.
  if (auth.session && !auth.session.emailVerified) return <VerifyEmail onVerified={onReady} />;

  return (
    <div className="card auth-card">
      {mode !== 'reset' && (
        <div className="auth-tabs" role="group" aria-label="Chọn cách vào">
          <button type="button" aria-pressed={mode === 'signin'} onClick={() => setMode('signin')}>
            Đăng nhập
          </button>
          <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
            Tạo tài khoản
          </button>
        </div>
      )}
      {mode === 'reset' ? (
        <ResetPassword onBack={() => setMode('signin')} />
      ) : (
        <>
          <GoogleButton label={googleLabel} onSignedIn={onReady} />
          <div className="divider" role="separator">
            <span>hoặc dùng email</span>
          </div>
          <EmailForm
            key={mode}
            mode={mode}
            onSignedIn={onReady}
            onForgot={() => setMode('reset')}
          />
        </>
      )}
    </div>
  );
}

function GoogleButton({
  label,
  onSignedIn,
}: {
  label: string;
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
    <form className="stack" onSubmit={(e) => e.preventDefault()}>
      {emulator && (
        <Field label="Email Google (giả lập)" hint="Chế độ giả lập: địa chỉ Google muốn đóng vai">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}
      <ErrorBox error={error} />
      <GoogleSubmit label={label} onClick={submit} disabled={emulator && !email.includes('@')} />
    </form>
  );
}

/** A full-width button with Google's "G", as Google's branding guidelines ask. */
function GoogleSubmit({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => Promise<void>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="submit"
      className="btn google block"
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
      <span>{busy ? 'Đang đăng nhập…' : label}</span>
    </button>
  );
}

function EmailForm({
  mode,
  onSignedIn,
  onForgot,
}: {
  mode: 'signin' | 'signup';
  onSignedIn: (session: Session) => Promise<void> | void;
  onForgot: () => void;
}) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const signup = mode === 'signup';

  const problem = !signup
    ? ''
    : password.length > 0 && password.length < MIN_PASSWORD
      ? `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`
      : again.length > 0 && again !== password
        ? 'Hai mật khẩu chưa khớp.'
        : '';
  const ready =
    email.includes('@') &&
    password.length >= (signup ? MIN_PASSWORD : 1) &&
    (!signup || again === password);

  async function submit() {
    setError('');
    let session: Session;
    try {
      session = signup
        ? await auth.signUpWithEmail(email, password)
        : await auth.signInWithEmail(email, password);
    } catch (err) {
      return setError(authErrorMessage(err));
    }
    // An unverified account stays here: the panel switches to the "check your inbox" step.
    if (session.emailVerified) await onSignedIn(session);
  }

  return (
    <form className="stack" onSubmit={(e) => e.preventDefault()} noValidate>
      <Field label="Email">
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field
        label="Mật khẩu"
        hint={signup ? `Ít nhất ${MIN_PASSWORD} ký tự. Không dùng lại mật khẩu email.` : undefined}
      >
        <input
          type={show ? 'text' : 'password'}
          autoComplete={signup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {signup && (
        <Field label="Nhập lại mật khẩu">
          <input
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </Field>
      )}
      <div className="row between">
        <label className="checkbox">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Hiện mật khẩu
        </label>
        {!signup && (
          <button type="button" className="link" onClick={onForgot}>
            Quên mật khẩu?
          </button>
        )}
      </div>
      {problem && <p className="hint warn">{problem}</p>}
      <ErrorBox error={error} />
      <ActionButton
        type="submit"
        onClick={submit}
        disabled={!ready}
        busyLabel={signup ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…'}
      >
        {signup ? 'Tạo tài khoản bằng email' : 'Đăng nhập bằng email'}
      </ActionButton>
      {signup && (
        <p className="hint">
          Chúng tôi sẽ gửi một liên kết xác minh tới email này. Mở liên kết đó rồi quay lại đây.
        </p>
      )}
    </form>
  );
}

function ResetPassword({ onBack }: { onBack: () => void }) {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  return (
    <form className="stack" onSubmit={(e) => e.preventDefault()}>
      <h2>Đặt lại mật khẩu</h2>
      {sent ? (
        <Notice tone="success">
          Nếu <b>{email}</b> có tài khoản dùng mật khẩu, thư đặt lại mật khẩu đã được gửi. Hãy kiểm
          tra hộp thư (cả mục Spam).
        </Notice>
      ) : (
        <>
          <p className="hint">
            Nhập email đã dùng để đăng ký. Tài khoản đăng nhập bằng Google thì không có mật khẩu:
            hãy dùng nút Google.
          </p>
          <Field label="Email">
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <ErrorBox error={error} />
          <ActionButton
            type="submit"
            disabled={!email.includes('@')}
            busyLabel="Đang gửi…"
            onClick={async () => {
              setError('');
              try {
                await resetPassword(email);
                setSent(true);
              } catch (err) {
                setError(authErrorMessage(err));
              }
            }}
          >
            Gửi liên kết đặt lại
          </ActionButton>
        </>
      )}
      <button type="button" className="link" onClick={onBack}>
        ← Quay lại đăng nhập
      </button>
    </form>
  );
}

/** Signed in with a password, address not verified yet. */
export function VerifyEmail({
  onVerified,
}: {
  onVerified: (session: Session) => Promise<void> | void;
}) {
  const auth = useAuth();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="card auth-card stack">
      <h2>Xác minh email của bạn</h2>
      <p>
        Chúng tôi đã gửi liên kết xác minh tới <b>{auth.session?.email}</b>. Mở thư đó, bấm vào liên
        kết, rồi quay lại đây.
      </p>
      <p className="hint">Không thấy thư? Kiểm tra mục Spam hoặc Quảng cáo, hoặc gửi lại.</p>
      {note && <Notice tone="info">{note}</Notice>}
      <ErrorBox error={error} />
      <ActionButton
        busyLabel="Đang kiểm tra…"
        onClick={async () => {
          setError('');
          setNote('');
          try {
            const s = await auth.checkVerified();
            if (s?.emailVerified) await onVerified(s);
            else setNote('Email vẫn chưa được xác minh. Hãy bấm liên kết trong thư trước.');
          } catch (err) {
            setError(authErrorMessage(err));
          }
        }}
      >
        Tôi đã xác minh xong
      </ActionButton>
      <div className="row between">
        <ActionButton
          variant="secondary"
          busyLabel="Đang gửi…"
          onClick={async () => {
            setError('');
            try {
              await auth.sendVerification();
              setNote('Đã gửi lại thư xác minh.');
            } catch (err) {
              setError(authErrorMessage(err));
            }
          }}
        >
          Gửi lại thư
        </ActionButton>
        <button type="button" className="link" onClick={() => void auth.signOut()}>
          Dùng tài khoản khác
        </button>
      </div>
    </div>
  );
}
