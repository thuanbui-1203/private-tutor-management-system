'use client';
/**
 * Admin: paying Tutors (docs/07 §6). Set each Class's rate, freeze a month's valid work into a
 * run, approve it, scan one QR; the server splits the money between the Tutors.
 */
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import {
  ActionButton,
  Badge,
  Confirm,
  DateTime,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Money,
  Notice,
  useLoad,
} from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { formatMoney, formatPeriod, todayVn } from '@/lib/format';
import {
  HELD_REASON,
  PAYOUT_STATUS,
  RUN_STATUS,
  type PayRateView,
  type PayrollPreview,
  type PayrollRunView,
} from '@/lib/payroll';
import type { ClassView, UserView } from '@/lib/types';

function previousMonth() {
  const [y, m] = todayVn().split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

export default function PayrollPage() {
  const tutors = useLoad(() => api.get<UserView[]>('/users', { role: 'TUTOR' }));
  const classes = useLoad(() => api.get<ClassView[]>('/classes'));
  const runs = useLoad(() => api.get<PayrollRunView[]>('/billing/payroll/runs'));
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const nameOf = (id: string) =>
    tutors.data?.find((t) => t.id === id)?.email ?? `Quản trị viên (${id.slice(0, 8)})`;
  const classOf = (id: string) => classes.data?.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const changed = () => {
    runs.reload();
    setVersion((v) => v + 1);
  };

  return (
    <>
      <h1>Trả công giáo viên</h1>
      <Rates classes={classes.data ?? []} onSaved={changed} />
      <Prepare
        key={`prepare-${version}`}
        nameOf={nameOf}
        classOf={classOf}
        onCreated={(id) => {
          setOpenId(id);
          changed();
        }}
      />
      <h2>Các kỳ chi trả</h2>
      <Loaded state={runs}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Chưa có kỳ chi trả nào.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tháng</th>
                    <th className="num">Tổng</th>
                    <th className="num">Đã nhận</th>
                    <th>Trạng thái</th>
                    <th>Tạo lúc</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td>{formatPeriod(r.period)}</td>
                      <td className="num">
                        <Money value={r.total} />
                      </td>
                      <td className="num">
                        <Money value={r.received} />
                      </td>
                      <td>
                        <Badge tone={RUN_STATUS[r.status][1]}>{RUN_STATUS[r.status][0]}</Badge>
                      </td>
                      <td>
                        <DateTime value={r.createdAt} />
                      </td>
                      <td>
                        <button
                          className="btn secondary small"
                          aria-expanded={openId === r.id}
                          onClick={() => setOpenId(openId === r.id ? null : r.id)}
                        >
                          {openId === r.id ? 'Đóng' : 'Chi tiết'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
      {openId && <Run key={openId} id={openId} nameOf={nameOf} onChanged={changed} />}
    </>
  );
}

/** The rate per Session of each Class; a change starts next month. */
function Rates({ classes, onSaved }: { classes: ClassView[]; onSaved: () => void }) {
  const rates = useLoad(() => api.get<PayRateView[]>('/billing/payroll/rates'));
  const [classId, setClassId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const period = todayVn().slice(0, 7);
  const current = (id: string) =>
    rates.data?.filter((r) => r.classId === id && r.effectiveFrom <= period).at(-1);
  const upcoming = (id: string) =>
    rates.data?.find((r) => r.classId === id && r.effectiveFrom > period);
  const value = Number(amount);
  return (
    <section className="card" aria-label="Mức công theo lớp">
      <h2 style={{ marginTop: 0 }}>Mức công mỗi buổi</h2>
      <p className="hint">
        Mức công cố định theo lớp, không phụ thuộc số học sinh. Lần đầu áp dụng cho cả buổi đã dạy;
        các lần đổi sau áp dụng từ tháng kế tiếp.
      </p>
      <form className="row" onSubmit={(e) => e.preventDefault()} style={{ alignItems: 'flex-end' }}>
        <Field label="Lớp">
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">Chọn lớp</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {current(c.id) ? ` – ${formatMoney(current(c.id)!.amount)}` : ' – chưa có'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tiền công mỗi buổi (₫)">
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <ActionButton
          type="submit"
          disabled={!classId || !(value > 0 && value <= 100_000_000)}
          onClick={async () => {
            setError('');
            setMessage('');
            try {
              const { data } = await api.put<PayRateView>(`/billing/payroll/rates/${classId}`, {
                amount: value,
              });
              setMessage(
                data.effectiveFrom > period
                  ? `Đã lưu, áp dụng từ ${formatPeriod(data.effectiveFrom)}.`
                  : 'Đã lưu, áp dụng ngay.',
              );
              setAmount('');
              rates.reload();
              onSaved();
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          Lưu mức công
        </ActionButton>
      </form>
      {classId && upcoming(classId) && (
        <p className="hint">
          Từ {formatPeriod(upcoming(classId)!.effectiveFrom)}:{' '}
          {formatMoney(upcoming(classId)!.amount)}
        </p>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      <ErrorBox error={error || rates.error} />
    </section>
  );
}

/** What a run would pay, before freezing it. */
function Prepare({
  nameOf,
  classOf,
  onCreated,
}: {
  nameOf: (id: string) => string;
  classOf: (id: string) => string;
  onCreated: (id: string) => void;
}) {
  const [period, setPeriod] = useState(previousMonth);
  const [error, setError] = useState('');
  const preview = useLoad(
    () => api.get<PayrollPreview>('/billing/payroll/preview', { period }),
    [period],
  );
  return (
    <section className="card" aria-label="Chốt công" style={{ marginTop: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Chốt công</h2>
      <Field
        label="Đến hết tháng"
        hint="Gồm cả buổi hợp lệ của các tháng trước chưa được trả. Buổi không có học sinh nào đến thì không tính công."
      >
        <input
          type="month"
          value={period}
          max={todayVn().slice(0, 7)}
          onChange={(e) => e.target.value && setPeriod(e.target.value)}
        />
      </Field>
      <Loaded state={preview}>
        {(p) => (
          <>
            {!p.canPay && (
              <Notice tone="warning">
                Chưa bật chi trả (PAYOUT_MODE). Vẫn chốt được công, nhưng chưa duyệt thanh toán
                được.
              </Notice>
            )}
            {p.classesWithoutRate.length > 0 && (
              <Notice tone="warning">
                Chưa có mức công, chưa tính: {p.classesWithoutRate.map(classOf).join(', ')}.
              </Notice>
            )}
            {p.tutors.length === 0 ? (
              <Empty>Không có công nào cần trả.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Giáo viên</th>
                      <th className="num">Số buổi</th>
                      <th className="num">Tiền công</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.tutors.map((t) => (
                      <tr key={t.tutorId}>
                        <td>{nameOf(t.tutorId)}</td>
                        <td className="num">{t.sessions}</td>
                        <td className="num">
                          <Money value={t.amount} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.held.map((h) => (
              <p key={h.tutorId} className="hint">
                Chưa trả {nameOf(h.tutorId)} ({formatMoney(h.amount)}): {HELD_REASON[h.reason]}.
              </p>
            ))}
            {p.tutors.length > 0 && (
              <p className="row">
                <span>
                  Tổng cộng: <b data-testid="preview-total">{formatMoney(p.total)}</b>
                </span>
                <ActionButton
                  onClick={async () => {
                    setError('');
                    try {
                      const { data } = await api.post<PayrollRunView>('/billing/payroll/runs', {
                        period,
                      });
                      onCreated(data.id);
                    } catch (err) {
                      setError(describeError(err));
                      preview.reload();
                    }
                  }}
                >
                  Tạo kỳ chi trả
                </ActionButton>
              </p>
            )}
          </>
        )}
      </Loaded>
      <ErrorBox error={error} />
    </section>
  );
}

const WAITING = new Set(['AWAITING_FUNDS', 'SETTLING']);

function Run({
  id,
  nameOf,
  onChanged,
}: {
  id: string;
  nameOf: (id: string) => string;
  onChanged: () => void;
}) {
  const run = useLoad(() => api.get<PayrollRunView>(`/billing/payroll/runs/${id}`), [id]);
  const [payUrl, setPayUrl] = useState('');
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const status = run.data?.status;

  // The owner pays on another device: follow the run until the money is split.
  const { setData } = run;
  useEffect(() => {
    if (!status || !WAITING.has(status)) return;
    const timer = setInterval(() => {
      api.get<PayrollRunView>(`/billing/payroll/runs/${id}`).then(
        (next) => {
          setData(next);
          if (next.status !== status) onChanged();
        },
        () => undefined, // shown on the next manual action; polling just goes on
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [status, id, setData, onChanged]);

  async function act(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    }
    run.reload();
    onChanged();
  }

  return (
    <section className="card" aria-label="Chi tiết kỳ chi trả" style={{ marginTop: '1rem' }}>
      <Loaded state={run}>
        {(r) => (
          <>
            <h2 style={{ marginTop: 0 }}>
              Kỳ {formatPeriod(r.period)}{' '}
              <Badge tone={RUN_STATUS[r.status][1]}>{RUN_STATUS[r.status][0]}</Badge>
            </h2>
            <p className="row">
              <span>
                Tổng: <b>{formatMoney(r.total)}</b>
              </span>
              <span>
                Đã nhận: <b>{formatMoney(r.received)}</b>
              </span>
            </p>
            {r.received > r.total && (
              <Notice tone="warning">
                Nhận thừa {formatMoney(r.received - r.total)}. Phần thừa không được chia cho ai.
              </Notice>
            )}
            {r.status === 'AWAITING_FUNDS' && payUrl && <PayQr url={payUrl} />}
            <div className="row" style={{ margin: '0.75rem 0' }}>
              {r.status === 'DRAFT' && (
                <ActionButton
                  onClick={() =>
                    act(async () => {
                      const { data } = await api.post<{ payUrl: string }>(
                        `/billing/payroll/runs/${id}/approve`,
                      );
                      setPayUrl(data.payUrl);
                    })
                  }
                >
                  Duyệt và hiện mã thanh toán
                </ActionButton>
              )}
              {r.status === 'AWAITING_FUNDS' && (
                <ActionButton
                  variant="secondary"
                  onClick={() =>
                    act(async () => {
                      const { data } = await api.post<{ payUrl: string }>(
                        `/billing/payroll/runs/${id}/pay-link`,
                      );
                      setPayUrl(data.payUrl);
                    })
                  }
                >
                  {payUrl ? 'Tạo mã mới' : 'Hiện mã thanh toán'}
                </ActionButton>
              )}
              {(r.status === 'DRAFT' || (r.status === 'AWAITING_FUNDS' && r.received === 0)) && (
                <button className="btn danger" onClick={() => setCancelling(true)}>
                  Hủy kỳ này
                </button>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Giáo viên</th>
                    <th className="num">Số tiền</th>
                    <th>Tài khoản</th>
                    <th>Trạng thái</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {r.payouts.map((p) => (
                    <tr key={p.id}>
                      <td>{nameOf(p.tutorId)}</td>
                      <td className="num">
                        <Money value={p.amount} />
                      </td>
                      <td>{p.accountNumberMasked ?? '—'}</td>
                      <td>
                        <Badge tone={PAYOUT_STATUS[p.status][1]}>
                          {PAYOUT_STATUS[p.status][0]}
                        </Badge>
                        {p.failureReason && <div className="hint">{p.failureReason}</div>}
                      </td>
                      <td>
                        {p.status === 'FAILED' && (
                          <ActionButton
                            variant="secondary"
                            onClick={() =>
                              act(() =>
                                api.post(`/billing/payroll/runs/${id}/payouts/${p.id}/retry`),
                              )
                            }
                          >
                            Chuyển lại
                          </ActionButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Confirm
              open={cancelling}
              title="Hủy kỳ chi trả này?"
              confirmLabel="Hủy kỳ"
              onCancel={() => setCancelling(false)}
              onConfirm={async () => {
                setCancelling(false);
                await act(() => api.post(`/billing/payroll/runs/${id}/cancel`));
              }}
            >
              <p>Các buổi trong kỳ trở lại danh sách chờ chốt. Không có tiền nào được chuyển.</p>
            </Confirm>
          </>
        )}
      </Loaded>
      <ErrorBox error={error} />
    </section>
  );
}

/** One QR for the whole run. In the sandbox it opens a simulated bank page: no real money. */
function PayQr({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let current = true;
    QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }).then((s) => {
      if (current) setSvg(s);
    });
    return () => {
      current = false;
    };
  }, [url]);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      {svg && (
        <div aria-label="Mã thanh toán" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <div className="stack">
        <p>
          <b>Chế độ giả lập:</b> quét mã không chuyển tiền thật. Mã có hiệu lực 30 phút.
        </p>
        <a href={url} target="_blank" rel="noreferrer">
          Mở trang thanh toán giả lập
        </a>
      </div>
    </div>
  );
}
