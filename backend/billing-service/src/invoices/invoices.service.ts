import { Injectable, NotFoundException } from '@nestjs/common';
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

  /**
   * GET /billing/students/{id}/invoices: one Student's issued Invoices (both kinds, paid or
   * not; drafts are not bills yet), for their Tutor, Admin and their Payer only.
   */
  async ofStudent(actor: AuthUser, studentId: string) {
    const student = await this.prisma.studentSnapshot.findUnique({ where: { studentId } });
    if (!student || !(await this.access.allowed(actor, studentId, student.tutorId))) {
      throw new NotFoundException('student not found');
    }
    const rows = await this.prisma.invoice.findMany({
      where: { studentId, status: { not: 'DRAFT' } },
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => invoiceView(r));
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
