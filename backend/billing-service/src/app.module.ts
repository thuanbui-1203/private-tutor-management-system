import { Module } from '@nestjs/common';
import { E2eHooksModule } from './e2e/e2e-hooks.module';
import { prismaDatabase, TmsCommonModule } from '@tms/common';
import { BankModule } from './bank/bank.module';
import { ChargesModule } from './charges/charges.module';
import { CopiesModule } from './copies/copies.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PaymentsModule } from './payments/payments.module';
import { PayrollModule } from './payroll/payroll.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    PrismaModule,
    TmsCommonModule.forRoot({
      service: 'billing',
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        database: prismaDatabase(prisma),
        rabbitmqUrl: process.env.RABBITMQ_URL,
      }),
    }),
    CopiesModule,
    ChargesModule,
    InvoicesModule,
    PaymentsModule,
    BankModule,
    PayrollModule,
    // Test-only hooks for the end-to-end suite (#21); off unless E2E_HOOKS=true.
    ...(process.env.E2E_HOOKS === 'true' ? [E2eHooksModule] : []),
  ],
})
export class AppModule {}
