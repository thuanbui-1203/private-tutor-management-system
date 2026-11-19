import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthUser } from '@tms/common';
import { InvoicesService } from './invoices.service';

@ApiTags('billing')
@Controller('billing')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

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
