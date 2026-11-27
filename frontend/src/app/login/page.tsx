'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SignInPanel } from '@/components/sign-in';
import { Loading, Notice } from '@/components/ui';
import { HOME_OF } from '@/lib/labels';

const REASONS: Record<string, string> = {
  session:
    'Phiên đăng nhập của bạn đã hết hạn hoặc bị thu hồi (ví dụ tài khoản vừa được đổi vai trò hoặc bị vô hiệu hóa). Vui lòng đăng nhập lại.',
};

/** Only a path on this site: `//elsewhere` would be another site. */
const localPath = (next: string | null) => (next && /^\/(?![/\\])/.test(next) ? next : undefined);

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reason = REASONS[params.get('reason') ?? ''];
  return (
    <main className="centered">
      <h1>Chào mừng bạn</h1>
      <p className="muted lead">Đăng nhập để xem lịch học, học phí và lớp của bạn.</p>
      {reason && <Notice tone="warning">{reason}</Notice>}
      <SignInPanel
        onReady={(s) =>
          router.replace(
            s.role ? (localPath(params.get('next')) ?? HOME_OF[s.role]) : '/register?complete=1',
          )
        }
      />
      <p className="hint">
        Lần đầu vào, bạn sẽ chọn vai trò: gia sư, học sinh hoặc phụ huynh. Nếu đã nhận email lời
        mời, hãy mở liên kết trong email đó.
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
