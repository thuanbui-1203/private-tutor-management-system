import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@tms/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceAccess } from './invoice-access';
import { invoiceView } from './views';

/** Reading Invoices (Tutor / Admin / Payer only). */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InvoiceAccess,
  ) {}

  async enrollmentInvoice(actor: AuthUser, enrollmentId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { enrollmentId, kind: 'ENROLLMENT', status: { not: 'VOID' } },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    await this.access.check(actor, invoice);
    return invoiceView(invoice!);
  }
}
