import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { BankAccountsController } from './bank-accounts.controller';
import { BankAccountsService } from './bank-accounts.service';

@Module({
  imports: [InvoicesModule], // StudentClient
  controllers: [BankAccountsController],
  providers: [BankAccountsService],
  exports: [BankAccountsService],
})
export class BankModule {}
