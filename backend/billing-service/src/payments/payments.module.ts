import { Module } from '@nestjs/common';
import { BankModule } from '../bank/bank.module';
import { ChargesModule } from '../charges/charges.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InternalPaymentsController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [ChargesModule, InvoicesModule, BankModule],
  controllers: [PaymentsController, InternalPaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
