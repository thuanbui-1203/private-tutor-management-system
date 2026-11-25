'use client';
/**
 * The simulated bank the owner opens by scanning a payroll QR. No login: the link's token is
 * the credential. Nothing here moves real money.
 */
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ErrorBox, Loaded, Notice, useLoad } from '@/components/ui';
import { describeError, request } from '@/lib/api';
import { formatMoney, formatPeriod } from '@/lib/format';
import type { SandboxPaymentView } from '@/lib/payroll';

type Outcome = 'SUCCESS' | 'SHORT' | 'FAIL';
const RESULT = {
  PAID: ['success', 'Đã thanh toán. Hệ thống đang chia tiền cho từng giáo viên.'],
  SHORT: ['warning', 'Đã chuyển thiếu. Kỳ chi trả vẫn chờ phần còn lại.'],
  FAILED: ['warning', 'Ngân hàng giả lập từ chối giao dịch. Chưa có tiền nào được chuyển.'],
} as const;

export default function SandboxPayPage() {
  const { token } = useParams<{ token: string }>();
  const path = `/billing/sandbox/payments/${encodeURIComponent(token)}`;
  const payment = useLoad(
    () => request<SandboxPaymentView>('GET', path, { auth: false }).then((r) => r.data),
    [path],
  );
  const [result, setResult] = useState<keyof typeof RESULT | null>(null);
  const [error, setError] = useState('');

  async function pay(outcome: Outcome) {
    setError('');
    setResult(null);
    try {
      const { data } = await request<{ status: keyof typeof RESULT }>('POST', path, {
        body: { outcome },
        auth: false,
      });
      setResult(data.status);
      if (data.status === 'SHORT') payment.reload();
    } catch (err) {
      setError(
        describeError(err, {
          404: 'Mã thanh toán đã hết hạn hoặc đã được thay bằng mã mới.',
          409: 'Kỳ chi trả này đã được thanh toán.',
        }),
      );
    }
  }

  return (
    <main className="centered">
      <h1>Ngân hàng giả lập</h1>
      <Notice tone="warning">Đây là trang thử nghiệm. Không có tiền thật nào được chuyển.</Notice>
      {result !== 'PAID' && (
        <Loaded state={payment}>
          {(p) => (
            <>
              <p>
                Trả công giáo viên kỳ {formatPeriod(p.period)}:{' '}
                <b>{formatMoney(p.total - p.received)}</b>
                {p.received > 0 && ` (đã nhận ${formatMoney(p.received)})`}
              </p>
              <div className="stack">
                <ActionButton onClick={() => pay('SUCCESS')}>Thanh toán</ActionButton>
                <ActionButton variant="secondary" onClick={() => pay('SHORT')}>
                  Giả lập chuyển thiếu một nửa
                </ActionButton>
                <ActionButton variant="secondary" onClick={() => pay('FAIL')}>
                  Giả lập thất bại
                </ActionButton>
              </div>
            </>
          )}
        </Loaded>
      )}
      {result && <Notice tone={RESULT[result][0]}>{RESULT[result][1]}</Notice>}
      <ErrorBox error={error} />
    </main>
  );
}
