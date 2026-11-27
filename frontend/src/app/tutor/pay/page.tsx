'use client';
/** Tutor: what each taught Session is worth, and the transfers received (docs/07 §6). */
import Link from 'next/link';
import { useState } from 'react';
import { Badge, DateText, DateTime, Empty, Field, Loaded, Money, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, formatPeriod, todayVn } from '@/lib/format';
import { PAYOUT_STATUS, WORK_STATUS, type PayoutView, type WorkItemView } from '@/lib/payroll';
import type { ClassView } from '@/lib/types';

export default function PayPage() {
  const [period, setPeriod] = useState(todayVn().slice(0, 7));
  const classes = useLoad(() => api.get<ClassView[]>('/classes'));
  const work = useLoad(
    () => api.get<WorkItemView[]>('/billing/payroll/work', { period }),
    [period],
  );
  const payouts = useLoad(() =>
    api.get<(PayoutView & { period: string })[]>('/billing/payroll/payouts'),
  );
  const classOf = (id: string) => classes.data?.find((c) => c.id === id)?.name ?? '—';
  return (
    <>
      <h1>Công dạy</h1>
      <p className="hint">
        Mỗi buổi đã điểm danh và có ít nhất một học sinh đến được tính một công. Công được chốt sau
        khi hết hạn sửa điểm danh 48 giờ. Tiền về <Link href="/tutor/bank-account">tài khoản</Link>{' '}
        bạn đã đồng ý lưu.
      </p>
      <Field label="Tháng">
        <input
          type="month"
          value={period}
          onChange={(e) => e.target.value && setPeriod(e.target.value)}
        />
      </Field>
      <Loaded state={work}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Chưa có buổi dạy nào trong {formatPeriod(period)}.</Empty>
          ) : (
            <>
              <div className="table-wrap" style={{ marginTop: '1rem' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Lớp</th>
                      <th className="num">Tiền công</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <DateText value={w.date} />
                        </td>
                        <td>
                          {classOf(w.classId)}
                          {w.kind === 'ADJUSTMENT' && ' (điều chỉnh điểm danh)'}
                        </td>
                        <td className="num">
                          {w.amount === null ? '—' : <Money value={w.amount} />}
                        </td>
                        <td>
                          <Badge tone={WORK_STATUS[w.status][1]}>{WORK_STATUS[w.status][0]}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Tổng tháng: <b>{formatMoney(list.reduce((sum, w) => sum + (w.amount ?? 0), 0))}</b>
              </p>
            </>
          )
        }
      </Loaded>
      <h2>Các lần chi trả</h2>
      <Loaded state={payouts}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Chưa có lần chi trả nào.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kỳ</th>
                    <th className="num">Số tiền</th>
                    <th>Tài khoản</th>
                    <th>Trạng thái</th>
                    <th>Lúc</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id}>
                      <td>{formatPeriod(p.period)}</td>
                      <td className="num">
                        <Money value={p.amount} />
                      </td>
                      <td>{p.accountNumberMasked ?? '—'}</td>
                      <td>
                        <Badge tone={PAYOUT_STATUS[p.status][1]}>
                          {PAYOUT_STATUS[p.status][0]}
                        </Badge>
                      </td>
                      <td>
                        <DateTime value={p.paidAt} />
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
