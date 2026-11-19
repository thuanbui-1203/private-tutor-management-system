import type { Invoice, InvoiceItem, Payment } from '../generated/prisma/client';
import { dateOnly } from './ledger.service';

/** The public shape of an Invoice (dates as YYYY-MM-DD, instants as ISO). */
export function invoiceView(invoice: Invoice & { items?: InvoiceItem[]; payments?: Payment[] }) {
  const paid = invoice.payments?.reduce(
    (sum, p) => sum + (p.kind === 'PAYMENT' ? p.amount : -p.amount),
    0,
  );
  return {
    id: invoice.id,
    kind: invoice.kind,
    studentId: invoice.studentId,
    enrollmentId: invoice.enrollmentId,
    studentName: invoice.studentName,
    payerContact: invoice.payerContact,
    period: invoice.period,
    total: invoice.total,
    status: invoice.status,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    dueDate: invoice.dueDate ? dateOnly(invoice.dueDate) : null,
    replacesInvoiceId: invoice.replacesInvoiceId,
    ...(invoice.payments && {
      paid,
      outstanding:
        invoice.status === 'DRAFT' || invoice.status === 'VOID' ? 0 : invoice.total - paid!,
      payments: invoice.payments.map((p) => ({
        id: p.id,
        kind: p.kind,
        reversesPaymentId: p.reversesPaymentId,
        amount: p.amount,
        method: p.method,
        paidAt: p.paidAt.toISOString(),
        note: p.note,
      })),
    }),
    ...(invoice.items && {
      items: invoice.items.map((i) => ({
        id: i.id,
        type: i.type,
        classId: i.classId,
        sessionId: i.sessionId,
        enrollmentId: i.enrollmentId,
        adjustsItemId: i.adjustsItemId,
        servicePeriod: i.servicePeriod,
        attendanceStatus: i.attendanceStatus,
        description: i.description,
        amount: i.amount,
      })),
    }),
  };
}
