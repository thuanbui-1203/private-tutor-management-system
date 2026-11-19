import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { InvoiceQuery, InvoicesService } from './invoices.service';
import { LifecycleService, VoidInput } from './lifecycle.service';

@ApiTags('billing')
@Controller('billing')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly lifecycle: LifecycleService,
  ) {}

  @Get('invoices')
  @Roles('TUTOR', 'ADMIN')
  list(@CurrentUser() actor: AuthUser, @Query(new ZodBody(InvoiceQuery)) query: InvoiceQuery) {
    return this.invoices.list(actor, query);
  }

  @Get('invoices/:id')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(actor, id);
  }

  /** Void an issued, unpaid Invoice and issue its replacement (BR-BI-04). */
  @Post('invoices/:id/void')
  @Roles('TUTOR', 'ADMIN')
  void(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(VoidInput)) body: VoidInput,
  ) {
    return this.lifecycle.voidAndReplace(actor, id, body);
  }

  /** The Enrollment invoice of a Monthly-fee Enrollment (BR-BI-06). */
  @Get('enrollments/:enrollmentId/invoice')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  enrollmentInvoice(
    @CurrentUser() actor: AuthUser,
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
  ) {
    return this.invoices.enrollmentInvoice(actor, enrollmentId);
  }
}
