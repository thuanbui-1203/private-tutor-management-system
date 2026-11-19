import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ChargesModule } from '../charges/charges.module';
import { InvoiceAccess } from './invoice-access';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { LifecycleService } from './lifecycle.service';
import { StudentClient } from './student.client';

/** Hour (Vietnam) from which overdue invoices are marked and reminded each day (BR-BI-03). */
const OVERDUE_HOUR = 8;

/**
 * Every 5 minutes: close the previous month if not yet done (00:00 on the 1st, BR-BI-02) and,
 * from 08:00, mark overdue Invoices and send reminders. Both jobs are idempotent.
 */
@Injectable()
class BillingJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BillingJobs.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly lifecycle: LifecycleService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const run = async () => {
      try {
        const now = new Date();
        await this.lifecycle.closeMonth(now);
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(now),
        );
        if (hour >= OVERDUE_HOUR) await this.lifecycle.markOverdue(now);
      } catch (err) {
        this.logger.error(`billing jobs failed: ${(err as Error).message}`);
      }
    };
    this.timer = setInterval(() => void run(), 5 * 60 * 1000);
    void run();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

@Module({
  imports: [ChargesModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceAccess, StudentClient, LifecycleService, BillingJobs],
  exports: [InvoicesService, InvoiceAccess, StudentClient, LifecycleService],
})
export class InvoicesModule {}
