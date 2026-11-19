import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles, ZodBody, type AuthUser } from '@tms/common';
import type { InternalOpenInvoicesResponse } from '@tms/contracts';
import { PaymentInput, PaymentsService, ReversalInput, RevenueQuery } from './payments.service';

@ApiTags('billing')
@Controller('billing')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Record money received; never more than what is still owed (BR-BI-07). */
  @Post('invoices/:id/payments')
  @Roles('TUTOR', 'ADMIN')
  record(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(PaymentInput)) body: PaymentInput,
  ) {
    return this.payments.record(actor, id, body);
  }

  /** Cancel a wrongly recorded Payment (Payments are never edited or deleted). */
  @Post('payments/:id/reversal')
  @Roles('TUTOR', 'ADMIN')
  reverse(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(ReversalInput)) body: ReversalInput,
  ) {
    return this.payments.reverse(actor, id, body);
  }

  @Get('students/:id/balance')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  balance(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.balance(actor, id);
  }

  @Get('reports/revenue')
  @Roles('TUTOR', 'ADMIN')
  revenue(@CurrentUser() actor: AuthUser, @Query(new ZodBody(RevenueQuery)) query: RevenueQuery) {
    return this.payments.revenue(actor, query);
  }

  @Get('invoices/:id/qr')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  qr(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.qr(actor, id);
  }
}

/** Service-to-service; the gateway never routes /internal/**. */
@ApiTags('internal')
@Public()
@Controller('internal')
export class InternalPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** BR-ST-08: student-service refuses Anonymisation while any of these exist. */
  @Get('students/:id/open-invoices')
  async openInvoices(
    @Param('id', ParseUUIDPipe) studentId: string,
  ): Promise<InternalOpenInvoicesResponse> {
    return { studentId, invoiceIds: await this.payments.openInvoiceIds(studentId) };
  }
}
