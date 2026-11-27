'use client';
/**
 * Bank details, stored only with consent (ADR-0006). The consent box starts unticked and
 * saving stays disabled until it is ticked; the API also refuses a body without it.
 * Withdrawing consent erases the full number at once and keeps a masked copy.
 */
import { useState } from 'react';
import {
  ActionButton,
  Badge,
  Confirm,
  DateTime,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { BankView, OwnBankAccountResponse, PayerBankAccount } from '@/lib/types';

/** Why the account is stored: the Tutor receives transfers, a Payer gets refunds. */
export type BankPurpose = 'receive' | 'refund';

const PURPOSE_TEXT: Record<BankPurpose, string> = {
  receive:
    'để tạo mã VietQR trên hóa đơn, giúp phụ huynh và học sinh chuyển học phí vào đúng tài khoản của tôi',
  refund: 'để giáo viên hoàn tiền vào tài khoản này khi cần (ví dụ học phí đóng thừa)',
};

/** The consent text the user agrees to; its version is sent with the form. */
export function ConsentText({ purpose, version }: { purpose: BankPurpose; version: string }) {
  return (
    <div className="hint" data-testid="consent-text">
      <p>
        Tôi đồng ý để hệ thống lưu số tài khoản ngân hàng, mã ngân hàng và tên chủ tài khoản của tôi{' '}
        {PURPOSE_TEXT[purpose]}.
      </p>
      <ul>
        <li>Số tài khoản được mã hóa; tôi chỉ thấy lại 4 số cuối.</li>
        <li>
          {purpose === 'refund'
            ? 'Chỉ giáo viên và quản trị viên xem được số đầy đủ, và chỉ khi tôi còn đồng ý.'
            : 'Số đầy đủ chỉ dùng để tạo mã VietQR trên hóa đơn.'}
        </li>
        <li>
          Tôi có thể rút lại sự đồng ý bất cứ lúc nào: số đầy đủ và tên chủ tài khoản bị xóa ngay,
          chỉ còn mã ngân hàng và 4 số cuối để đối chiếu các giao dịch cũ.
        </li>
      </ul>
      <p>Phiên bản điều khoản: {version}</p>
    </div>
  );
}

export function BankAccountSettings({ purpose }: { purpose: BankPurpose }) {
  const state = useLoad(() => api.get<OwnBankAccountResponse>('/billing/bank-account'));
  const banks = useLoad(() => api.get<BankView[]>('/billing/banks'));
  const bankName = (bin: string) => banks.data?.find((b) => b.bin === bin)?.shortName ?? bin;
  const [bankBin, setBankBin] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [consent, setConsent] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);

  const valid =
    /^\d{6}$/.test(bankBin) && /^\d{6,19}$/.test(accountNumber) && accountName.trim() !== '';

  return (
    <>
      <h1>Tài khoản ngân hàng</h1>
      {message && <Notice tone="success">{message}</Notice>}
      <ErrorBox error={error} />
      <Loaded state={state}>
        {({ policyVersion, account }) => (
          <div className="stack">
            <section className="card" aria-label="Tài khoản đang lưu">
              {!account ? (
                <Empty>Chưa lưu tài khoản ngân hàng nào.</Empty>
              ) : (
                <dl>
                  <dt>Trạng thái</dt>
                  <dd>
                    {account.status === 'ACTIVE' ? (
                      <Badge tone="green">Đang dùng (đã đồng ý)</Badge>
                    ) : (
                      <Badge tone="neutral">Đã rút đồng ý, chỉ còn bản đã che</Badge>
                    )}
                  </dd>
                  <dt>Ngân hàng</dt>
                  <dd>{bankName(account.bankBin)}</dd>
                  <dt>Số tài khoản</dt>
                  <dd data-testid="masked-number">{account.accountNumberMasked}</dd>
                  {account.accountName && (
                    <>
                      <dt>Chủ tài khoản</dt>
                      <dd>{account.accountName}</dd>
                    </>
                  )}
                  <dt>Đồng ý lúc</dt>
                  <dd>
                    <DateTime value={account.consent.grantedAt} />
                  </dd>
                  {account.consent.withdrawnAt && (
                    <>
                      <dt>Rút đồng ý lúc</dt>
                      <dd>
                        <DateTime value={account.consent.withdrawnAt} />
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {account?.status === 'ACTIVE' && (
                <button className="btn secondary" onClick={() => setWithdrawing(true)}>
                  Rút lại đồng ý
                </button>
              )}
            </section>

            <form
              className="card stack"
              aria-label="Lưu tài khoản ngân hàng"
              onSubmit={(e) => e.preventDefault()}
            >
              <h2>{account?.status === 'ACTIVE' ? 'Đổi tài khoản' : 'Lưu tài khoản'}</h2>
              <Field label="Ngân hàng">
                <select value={bankBin} onChange={(e) => setBankBin(e.target.value)}>
                  <option value="">Chọn ngân hàng</option>
                  {(banks.data ?? []).map((b) => (
                    <option key={b.bin} value={b.bin}>
                      {b.shortName} – {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Số tài khoản">
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value.replace(/\s/g, ''))}
                />
              </Field>
              <Field label="Tên chủ tài khoản">
                <input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
              </Field>
              <ConsentText purpose={purpose} version={policyVersion} />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Tôi đã đọc và đồng ý cho lưu thông tin ngân hàng như trên
              </label>
              <div className="row end">
                <ActionButton
                  disabled={!consent || !valid}
                  onClick={async () => {
                    setError(null);
                    setMessage('');
                    try {
                      await api.put('/billing/bank-account', {
                        bankBin,
                        accountNumber,
                        accountName: accountName.trim(),
                        consent: true,
                        policyVersion,
                      });
                      setAccountNumber('');
                      setConsent(false);
                      setMessage('Đã lưu tài khoản ngân hàng.');
                      state.reload();
                    } catch (err) {
                      setError(err);
                    }
                  }}
                >
                  Lưu tài khoản
                </ActionButton>
              </div>
            </form>

            <Confirm
              open={withdrawing}
              title="Rút lại đồng ý?"
              confirmLabel="Rút đồng ý"
              onCancel={() => setWithdrawing(false)}
              onConfirm={async () => {
                try {
                  await api.delete('/billing/bank-account/consent');
                  setMessage('Đã rút đồng ý. Số tài khoản đầy đủ đã bị xóa.');
                  state.reload();
                } catch (err) {
                  setError(err);
                } finally {
                  setWithdrawing(false);
                }
              }}
            >
              Số tài khoản đầy đủ và tên chủ tài khoản sẽ bị xóa ngay. Hệ thống chỉ giữ mã ngân hàng
              và 4 số cuối để đối chiếu các giao dịch cũ.
              {purpose === 'receive' && ' Mã VietQR trên hóa đơn sẽ không dùng tài khoản này nữa.'}
            </Confirm>
          </div>
        )}
      </Loaded>
    </>
  );
}

/** Tutor / Admin: the Payers' accounts, for refunds. Full number only while consented. */
export function PayerBankAccounts() {
  const state = useLoad(() => api.get<PayerBankAccount[]>('/billing/bank-accounts'));
  const banks = useLoad(() => api.get<BankView[]>('/billing/banks'));
  const bankName = (bin: string) => banks.data?.find((b) => b.bin === bin)?.shortName ?? bin;
  return (
    <>
      <h1>Tài khoản ngân hàng của người thanh toán</h1>
      <p className="hint">
        Chỉ dùng để hoàn tiền. Số đầy đủ chỉ hiện khi người thanh toán còn đồng ý; sau khi họ rút
        đồng ý chỉ còn 4 số cuối. Mỗi lần mở trang này đều được ghi vào nhật ký.
      </p>
      <Loaded state={state}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Chưa có người thanh toán nào lưu tài khoản.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Chủ tài khoản</th>
                    <th>Mã ngân hàng</th>
                    <th>Số tài khoản</th>
                    <th>Trạng thái</th>
                    <th>Đồng ý lúc</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.ownerId}>
                      <td>{a.accountName ?? '—'}</td>
                      <td>{bankName(a.bankBin)}</td>
                      <td>{a.accountNumber ?? a.accountNumberMasked}</td>
                      <td>
                        {a.status === 'ACTIVE' ? (
                          <Badge tone="green">Đang đồng ý</Badge>
                        ) : (
                          <Badge tone="neutral">Đã rút đồng ý</Badge>
                        )}
                      </td>
                      <td>
                        <DateTime value={a.consent.grantedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
    </>
  );
}
