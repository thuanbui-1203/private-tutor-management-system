'use client';
/** Revenue by month: billed (lines of issued Invoices) and collected (payments − reversals). */
import { useState } from 'react';
import { ErrorBox, Field, Loaded, Money, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { formatPeriod, todayVn } from '@/lib/format';
import type { RevenueReport } from '@/lib/types';

function monthsBack(period: string, n: number) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
}

export default function RevenuePage() {
  const current = todayVn().slice(0, 7);
  const [from, setFrom] = useState(monthsBack(current, 5));
  const [to, setTo] = useState(current);
  const valid = from <= to;
  const report = useLoad(
    () =>
      valid
        ? api.get<RevenueReport>('/billing/reports/revenue', { from, to })
        : Promise.resolve(undefined),
    [from, to],
  );
  return (
    <>
      <h1>Doanh thu</h1>
      <div className="row">
        <Field label="Từ tháng">
          <input
            type="month"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </Field>
        <Field label="Đến tháng">
          <input
            type="month"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </Field>
      </div>
      {!valid ? (
        <ErrorBox error="Tháng bắt đầu phải trước tháng kết thúc." />
      ) : (
        <Loaded state={report}>
          {(r) =>
            r && (
              <>
                <p className="row" style={{ margin: '1rem 0' }}>
                  <span>
                    Đã lập hóa đơn:{' '}
                    <b>
                      <Money value={r.billed} />
                    </b>
                  </span>
                  <span>
                    Đã thu:{' '}
                    <b>
                      <Money value={r.collected} />
                    </b>
                  </span>
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Tháng</th>
                        <th className="num">Đã lập hóa đơn</th>
                        <th className="num">Đã thu</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.months.map((m) => (
                        <tr key={m.period}>
                          <td>{formatPeriod(m.period)}</td>
                          <td className="num">
                            <Money value={m.billed} />
                          </td>
                          <td className="num">
                            <Money value={m.collected} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="hint" style={{ marginTop: '0.5rem' }}>
                  “Đã lập hóa đơn” tính theo tháng của khoản phí, chỉ các hóa đơn đã phát hành; “Đã
                  thu” tính theo tháng nhận tiền, đã trừ bút toán đảo.
                </p>
              </>
            )
          }
        </Loaded>
      )}
    </>
  );
}
