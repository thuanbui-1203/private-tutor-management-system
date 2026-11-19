'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { InvoiceDetail } from '@/components/invoice';
import { Loaded, Notice, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { InvoiceView } from '@/lib/types';

export default function TutorInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const invoice = useLoad(() => api.get<InvoiceView>(`/billing/invoices/${id}`), [id]);
  const [message, setMessage] = useState('');
  return (
    <>
      <p>
        <Link href="/tutor/invoices">← Danh sách hóa đơn</Link>
      </p>
      {message && <Notice tone="success">{message}</Notice>}
      <Loaded state={invoice}>
        {(inv) => (
          <InvoiceDetail
            invoice={inv}
            canManage
            onChanged={(msg) => {
              // "text|replacementId" after a void-and-replace: open the new invoice.
              const [text, replacement] = (msg ?? '').split('|');
              setMessage(text);
              if (replacement) router.push(`/tutor/invoices/${replacement}`);
              else invoice.reload();
            }}
          />
        )}
      </Loaded>
    </>
  );
}
