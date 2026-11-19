import { Module } from '@nestjs/common';
import { InvoiceAccess } from './invoice-access';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { StudentClient } from './student.client';

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceAccess, StudentClient],
  exports: [InvoicesService, InvoiceAccess, StudentClient],
})
export class InvoicesModule {}
