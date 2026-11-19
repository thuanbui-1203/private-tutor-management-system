import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@tms/common';
import { InvoiceKind, InvoiceStatus, Period } from '@tms/contracts';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceAccess } from './invoice-access';
import { invoiceView } from './views';

export const InvoiceQuery = z.object({
  period: Period.optional(),
  status: InvoiceStatus.optional(),
  kind: InvoiceKind.optional(),
  studentId: z.uuid().optional(),
});
export type InvoiceQuery = z.infer<typeof InvoiceQuery>;

/** Reading Invoices (Tutor / Admin / Payer only). */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InvoiceAccess,
  ) {}

  /** GET /billing/invoices: a Tutor sees their Students' Invoices, Admin all. */
  async list(actor: AuthUser, q: InvoiceQuery) {
    const rows = await this.prisma.invoice.findMany({
      where: {
        ...(actor.role === 'TUTOR' && { tutorId: actor.id }),
        ...(q.period && { period: q.period }),
        ...(q.status && { status: q.status }),
        ...(q.kind && { kind: q.kind }),
        ...(q.studentId && { studentId: q.studentId }),
      },
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => invoiceView(r));
  }

  /** GET /billing/invoices/{id}: with its lines; 404 for anyone but Tutor, Admin and the Payer. */
  async get(actor: AuthUser, id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    await this.access.check(actor, invoice);
    return invoiceView(invoice!);
  }

  async enrollmentInvoice(actor: AuthUser, enrollmentId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { enrollmentId, kind: 'ENROLLMENT', status: { not: 'VOID' } },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    await this.access.check(actor, invoice);
    return invoiceView(invoice!);
  }
}
