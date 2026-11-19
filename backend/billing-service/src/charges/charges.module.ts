import { Module } from '@nestjs/common';
import { CopiesModule } from '../copies/copies.module';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { LedgerService } from '../invoices/ledger.service';
import { ChargesService } from './charges.service';

@Module({
  imports: [CopiesModule],
  providers: [LedgerService, ChargesService, EnrollmentsService],
  exports: [LedgerService, ChargesService, EnrollmentsService],
})
export class ChargesModule {}
