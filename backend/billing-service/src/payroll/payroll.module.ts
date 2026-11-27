import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BankModule } from '../bank/bank.module';
import { PAYROLL_CONFIG, payrollConfig } from './payout-provider';
import { PayrollController, SandboxPaymentsController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { WorkModule } from './work.module';

/** Every minute: payouts interrupted by a restart or a provider timeout. Idempotent. */
@Injectable()
class PayrollJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PayrollJobs.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly payroll: PayrollService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.payroll
        .resume()
        .catch((err) => this.logger.error(`payroll resume failed: ${(err as Error).message}`));
    }, 60_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

@Module({
  imports: [WorkModule, BankModule],
  controllers: [PayrollController, SandboxPaymentsController],
  providers: [
    PayrollService,
    PayrollJobs,
    { provide: PAYROLL_CONFIG, useFactory: () => payrollConfig() },
  ],
})
export class PayrollModule {}
