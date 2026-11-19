import type { Invoice, InvoiceItem } from '../generated/prisma/client';
import { dateOnly } from './ledger.service';

/** The public shape of an Invoice (dates as YYYY-MM-DD, instants as ISO). */
export function invoiceView(invoice: Invoice & { items?: InvoiceItem[] }) {
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
