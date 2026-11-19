'use client';
import Link from 'next/link';
import { useState } from 'react';
import { InvoiceBadge } from '@/components/badges';
import { DateText, Empty, Field, Loaded, Money, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { formatPeriod, todayVn } from '@/lib/format';
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL } from '@/lib/labels';
import type { InvoiceView } from '@/lib/types';

export default function InvoicesPage() {
  const [period, setPeriod] = useState(todayVn().slice(0, 7));
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const list = useLoad(
    () => api.get<InvoiceView[]>('/billing/invoices', { period, status, kind }),
    [period, status, kind],
  );
  return (
    <>
      <h1>Hóa đơn</h1>
      <div className="row">
        <Field label="Kỳ">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="Trạng thái">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tất cả</option>
            {Object.entries(INVOICE_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Loại hóa đơn">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Tất cả</option>
            {Object.entries(INVOICE_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Loaded state={list}>
        {(invoices) =>
          invoices.length === 0 ? (
            <Empty>Không có hóa đơn nào khớp bộ lọc.</Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Học sinh</th>
                    <th>Loại</th>
                    <th>Kỳ</th>
                    <th>Hạn</th>
                    <th>Trạng thái</th>
                    <th className="num">Tổng</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`/tutor/invoices/${i.id}`}>{i.studentName}</Link>
                      </td>
                      <td>{INVOICE_KIND_LABEL[i.kind]}</td>
                      <td>{formatPeriod(i.period)}</td>
                      <td>{i.dueDate ? <DateText value={i.dueDate} /> : '—'}</td>
                      <td>
                        <InvoiceBadge status={i.status} />
                      </td>
                      <td className="num">
                        <Money value={i.total} />
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
