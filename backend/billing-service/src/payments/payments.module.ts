import { Module } from '@nestjs/common';
import { ChargesModule } from '../charges/charges.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InternalPaymentsController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [ChargesModule, InvoicesModule],
  controllers: [PaymentsController, InternalPaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
