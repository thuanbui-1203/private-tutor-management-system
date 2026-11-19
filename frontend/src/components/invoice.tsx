'use client';
/**
 * Invoice detail, shared by the Tutor (who can record money) and the Payer (read + VietQR):
 * FEE and ADJUSTMENT lines (each Adjustment says what it corrects, ADR-0002), payments and
 * reversals, and for the Tutor: record a payment, reverse one, void and replace.
 */
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { AttendanceBadge, InvoiceBadge } from '@/components/badges';
import {
  ActionButton,
  Confirm,
  DateText,
  DateTime,
  ErrorBox,
  Field,
  Loaded,
  Money,
  Notice,
  useLoad,
} from '@/components/ui';
import { ApiError, api, describeError } from '@/lib/api';
import { formatMoney, formatPeriod } from '@/lib/format';
import { INVOICE_KIND_LABEL, PAYMENT_METHOD_LABEL } from '@/lib/labels';
import type { BalanceView, InvoiceView, PaymentMethod, QrView } from '@/lib/types';

const PAYABLE = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];

export function InvoiceDetail({
  invoice,
  canManage,
  onChanged,
}: {
  invoice: InvoiceView;
  canManage: boolean;
  onChanged: (message?: string) => void;
}) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [error, setError] = useState('');
  const payable = PAYABLE.includes(invoice.status);
  const reversed = new Set(
    (invoice.payments ?? []).filter((p) => p.kind === 'REVERSAL').map((p) => p.reversesPaymentId),
  );

  return (
    <>
      <h1>
        {INVOICE_KIND_LABEL[invoice.kind]} kỳ {formatPeriod(invoice.period)}{' '}
        <InvoiceBadge status={invoice.status} />
      </h1>
      {invoice.status === 'OVERDUE' && (
        <Notice tone="warning">
          Hóa đơn đã quá hạn thanh toán ({formatDueDate(invoice.dueDate)}). Vui lòng thanh toán sớm.
        </Notice>
      )}
      {invoice.replacesInvoiceId && (
        <Notice tone="info">Hóa đơn này thay thế một hóa đơn đã bị hủy.</Notice>
      )}
      <section className="card">
        <div className="grid">
          <div>
            <div className="hint">Học sinh</div>
            {invoice.studentName}
          </div>
          <div>
            <div className="hint">Người thanh toán</div>
            {invoice.payerContact?.name ?? '—'}
            <div className="hint">
              {[invoice.payerContact?.email, invoice.payerContact?.phone]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <div>
            <div className="hint">Ngày phát hành</div>
            {invoice.issuedAt ? (
              <DateTime value={invoice.issuedAt} />
            ) : (
              'Chưa phát hành (đang tạm tính)'
            )}
          </div>
          <div>
            <div className="hint">Hạn thanh toán</div>
            {formatDueDate(invoice.dueDate)}
          </div>
        </div>
      </section>

      <h2>Các dòng phí</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nội dung</th>
              <th>Loại</th>
              <th className="num">Số tiền</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.items ?? []).map((i) => (
              <tr key={i.id}>
                <td>
                  {i.description}
                  {i.attendanceStatus && (
                    <>
                      {' '}
                      <AttendanceBadge status={i.attendanceStatus} />
                    </>
                  )}
                  {i.type === 'ADJUSTMENT' && (
                    <div className="hint">
                      Dòng điều chỉnh cho{' '}
                      {i.sessionId ? 'một buổi học' : i.enrollmentId ? 'học phí ghi danh' : 'số dư'}{' '}
                      của kỳ {formatPeriod(i.servicePeriod)} (hóa đơn đã phát hành không bị sửa)
                    </div>
                  )}
                  {i.type === 'FEE' && i.servicePeriod !== invoice.period && (
                    <div className="hint">
                      Phí của kỳ {formatPeriod(i.servicePeriod)}, ghi nhận sau khi kỳ đó đã chốt
                    </div>
                  )}
                </td>
                <td>{i.type === 'FEE' ? 'Phí' : 'Điều chỉnh'}</td>
                <td className="num">
                  <Money value={i.amount} />
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2}>
                <b>Tổng cộng</b>
              </td>
              <td className="num">
                <b>
                  <Money value={invoice.total} />
                </b>
              </td>
            </tr>
            {invoice.paid !== undefined &&
              invoice.status !== 'DRAFT' &&
              invoice.status !== 'VOID' && (
                <>
                  <tr>
                    <td colSpan={2}>Đã thanh toán</td>
                    <td className="num">
                      <Money value={invoice.paid} />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2}>
                      <b>Còn phải trả</b>
                    </td>
                    <td className="num">
                      <b>
                        <Money value={invoice.outstanding ?? 0} />
                      </b>
                    </td>
                  </tr>
                </>
              )}
          </tbody>
        </table>
      </div>

      <h2>Lịch sử thanh toán</h2>
      {(invoice.payments ?? []).length === 0 ? (
        <p className="muted">Chưa có khoản thanh toán nào.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Loại</th>
                <th>Hình thức</th>
                <th className="num">Số tiền</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {invoice.payments!.map((p) => (
                <tr key={p.id}>
                  <td>
                    <DateTime value={p.paidAt} />
                  </td>
                  <td>
                    {p.kind === 'PAYMENT' ? 'Thanh toán' : 'Bút toán đảo'}
                    {p.note && <div className="hint">{p.note}</div>}
                  </td>
                  <td>{PAYMENT_METHOD_LABEL[p.method]}</td>
                  <td className="num">
                    {p.kind === 'REVERSAL' ? '−' : ''}
                    <Money value={p.amount} />
                  </td>
                  {canManage && (
                    <td>
                      {p.kind === 'PAYMENT' && !reversed.has(p.id) && (
                        <ReverseButton
                          paymentId={p.id}
                          amount={p.amount}
                          onDone={onChanged}
                          onError={setError}
                        />
                      )}
                      {p.kind === 'PAYMENT' && reversed.has(p.id) && (
                        <span className="muted">Đã đảo</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorBox error={error} />

      {payable && canManage && (
        <RecordPayment
          // Remount after each payment so the amount pre-fills with what is left.
          key={invoice.outstanding}
          invoiceId={invoice.id}
          outstanding={invoice.outstanding ?? invoice.total}
          onDone={onChanged}
        />
      )}
      {payable && (invoice.outstanding ?? 1) > 0 && <VietQr invoiceId={invoice.id} />}

      {canManage && payable && (invoice.paid ?? 0) === 0 && (
        <>
          <h2>Hủy và phát hành lại</h2>
          <p className="hint">
            Dùng khi hóa đơn sai (ví dụ sai tên người thanh toán). Hóa đơn cũ được giữ lại với trạng
            thái đã hủy.
          </p>
          <button className="btn secondary" onClick={() => setVoiding(true)}>
            Hủy hóa đơn và phát hành hóa đơn thay thế
          </button>
          <Confirm
            open={voiding}
            title="Hủy hóa đơn này?"
            confirmLabel="Hủy và phát hành lại"
            onCancel={() => setVoiding(false)}
            onConfirm={async () => {
              setError('');
              if (!reason.trim()) return setReasonError('Cần nhập lý do hủy.');
              try {
                const res = await api.post<{ replacement: InvoiceView }>(
                  `/billing/invoices/${invoice.id}/void`,
                  {
                    reason: reason.trim(),
                  },
                );
                setVoiding(false);
                onChanged(
                  `Đã hủy hóa đơn và phát hành hóa đơn thay thế.|${res.data.replacement.id}`,
                );
              } catch (err) {
                setVoiding(false);
                setError(
                  describeError(err, {
                    409: 'Không hủy được: hóa đơn đã có thanh toán (hãy tạo bút toán đảo trước) hoặc không còn ở trạng thái phát hành.',
                  }),
                );
              }
            }}
          >
            <Field label="Lý do hủy">
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <ErrorBox error={reasonError} />
            <p className="hint">
              Hóa đơn thay thế giữ nguyên các dòng phí, dùng thông tin người thanh toán mới nhất.
            </p>
          </Confirm>
        </>
      )}
    </>
  );
}

function formatDueDate(date: string | null) {
  return date ? <DateText value={date} /> : '—';
}

function ReverseButton({
  paymentId,
  amount,
  onDone,
  onError,
}: {
  paymentId: string;
  amount: number;
  onDone: (message?: string) => void;
  onError: (e: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  return (
    <>
      <button className="btn secondary small" onClick={() => setOpen(true)}>
        Tạo bút toán đảo
      </button>
      <Confirm
        open={open}
        title={`Đảo khoản thanh toán ${formatMoney(amount)}?`}
        confirmLabel="Tạo bút toán đảo"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          if (!reason.trim()) return setReasonError('Cần nhập lý do đảo.');
          try {
            await api.post(`/billing/payments/${paymentId}/reversal`, { reason: reason.trim() });
            setOpen(false);
            onDone('Đã tạo bút toán đảo. Khoản thanh toán cũ vẫn được lưu trong lịch sử.');
          } catch (err) {
            setOpen(false);
            onError(describeError(err, { 409: 'Khoản này đã được đảo trước đó.' }));
          }
        }}
      >
        <Field label="Lý do đảo">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox error={reasonError} />
        <p className="hint">
          Thanh toán không bao giờ bị sửa hay xóa (BR-BI-07); bút toán đảo ghi nhận việc hủy khoản
          ghi sai.
        </p>
      </Confirm>
    </>
  );
}

function RecordPayment({
  invoiceId,
  outstanding,
  onDone,
}: {
  invoiceId: string;
  outstanding: number;
  onDone: (message?: string) => void;
}) {
  const [amount, setAmount] = useState(String(outstanding));
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="card stack"
      onSubmit={(e) => e.preventDefault()}
      aria-label="Ghi nhận thanh toán"
      style={{ marginTop: '1rem' }}
    >
      <strong>Ghi nhận thanh toán</strong>
      <div className="grid">
        <Field label="Số tiền (VND)" hint={`Còn phải trả ${formatMoney(outstanding)}`}>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Hình thức">
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ghi chú">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <ErrorBox error={error} />
      <ActionButton
        type="submit"
        busyLabel="Đang ghi nhận…"
        onClick={async () => {
          setError('');
          const value = Number(amount);
          if (!Number.isInteger(value) || value <= 0)
            return setError('Số tiền phải là số nguyên VND lớn hơn 0.');
          if (value > outstanding) {
            return setError(`Số tiền vượt số còn nợ (${formatMoney(outstanding)}) (BR-BI-07).`);
          }
          try {
            const res = await api.post<{ invoiceStatus: string }>(
              `/billing/invoices/${invoiceId}/payments`,
              {
                amount: value,
                method,
                ...(note.trim() && { note: note.trim() }),
              },
            );
            onDone(
              res.data.invoiceStatus === 'PAID'
                ? 'Đã ghi nhận thanh toán. Hóa đơn đã được thanh toán đủ.'
                : 'Đã ghi nhận thanh toán một phần.',
            );
          } catch (err) {
            const rest =
              err instanceof ApiError
                ? (err.body as { outstanding?: number })?.outstanding
                : undefined;
            setError(
              rest !== undefined
                ? `Số tiền vượt số còn nợ (${formatMoney(rest)}) (BR-BI-07).`
                : describeError(err),
            );
          }
        }}
      >
        Ghi nhận
      </ActionButton>
    </form>
  );
}

/** VietQR for what is still owed: scan in any Vietnamese banking app. */
export function VietQr({ invoiceId }: { invoiceId: string }) {
  const qr = useLoad(() => api.get<QrView>(`/billing/invoices/${invoiceId}/qr`), [invoiceId]);
  const [svg, setSvg] = useState('');
  useEffect(() => {
    if (!qr.data) return;
    let current = true;
    QRCode.toString(qr.data.payload, { type: 'svg', margin: 1, width: 220 }).then(
      (s) => current && setSvg(s),
    );
    return () => {
      current = false;
    };
  }, [qr.data]);
  if (qr.error instanceof ApiError && qr.error.status === 503) {
    return (
      <p className="hint">Chưa cấu hình tài khoản nhận chuyển khoản, chưa tạo được mã VietQR.</p>
    );
  }
  return (
    <section className="card" aria-label="VietQR" style={{ marginTop: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Chuyển khoản bằng VietQR</h2>
      <Loaded state={qr}>
        {(q) => (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            {svg && (
              <div aria-label="Mã VietQR" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
            )}
            <div className="stack">
              <div>
                Số tiền: <b>{formatMoney(q.amount)}</b>
              </div>
              <div>
                Nội dung chuyển khoản: <b>{q.description}</b>
              </div>
              <div>
                Tài khoản: {q.accountNumber}
                {q.accountName && ` – ${q.accountName}`}
              </div>
              <p className="hint">
                Quét mã bằng ứng dụng ngân hàng; số tiền và nội dung đã được điền sẵn.
              </p>
            </div>
          </div>
        )}
      </Loaded>
    </section>
  );
}

/** A Student's balance: what is still owed, Invoice by Invoice. */
export function BalanceSection({
  studentId,
  invoiceHref,
}: {
  studentId: string;
  invoiceHref: (id: string) => string;
}) {
  const balance = useLoad(
    () => api.get<BalanceView>(`/billing/students/${studentId}/balance`),
    [studentId],
  );
  return (
    <section aria-label="Công nợ">
      <Loaded state={balance}>
        {(b) => (
          <>
            <p className="row">
              <span>
                Còn phải trả:{' '}
                <b>
                  <Money value={b.outstanding} />
                </b>
              </span>
              {b.overdue > 0 && <span className="badge red">Quá hạn {formatMoney(b.overdue)}</span>}
              {b.currentMonthDraft !== 0 && (
                <span className="hint">
                  Phí tạm tính tháng này: {formatMoney(b.currentMonthDraft)}
                </span>
              )}
            </p>
            {b.invoices.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Hóa đơn</th>
                      <th>Hạn</th>
                      <th>Trạng thái</th>
                      <th className="num">Còn nợ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.invoices.map((i) => (
                      <tr key={i.invoiceId}>
                        <td>
                          <Link href={invoiceHref(i.invoiceId)}>
                            {INVOICE_KIND_LABEL[i.kind]} {formatPeriod(i.period)}
                          </Link>
                        </td>
                        <td>{i.dueDate ? <DateText value={i.dueDate} /> : '—'}</td>
                        <td>
                          <InvoiceBadge status={i.status} />
                        </td>
                        <td className="num">
                          <Money value={i.outstanding} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Loaded>
    </section>
  );
}
