import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Messaging } from '@tms/common';
import { EnrollmentsService } from './enrollments.service';

/** Wires the Class side of the enrollment Saga to RabbitMQ and runs its periodic jobs. */
@Injectable()
export class EnrollmentsConsumers
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EnrollmentsConsumers.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly messaging: Messaging,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.messaging.subscribe('EnrollmentConfirmed', (e, tx) =>
      this.enrollments.onConfirmed(e, tx),
    );
    await this.messaging.subscribe('EnrollmentSyncFailed', (e, tx) =>
      this.enrollments.onSyncFailed(e, tx),
    );
    await this.messaging.subscribe('PaymentReceived', (e, tx) => this.enrollments.onPayment(e, tx));
    await this.messaging.subscribe('StudentStatusChanged', (e, tx) =>
      this.enrollments.onStudentStatus(e, tx),
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const every = (ms: number, name: string, job: () => Promise<number>) =>
      this.timers.push(
        setInterval(
          () => void job().catch((err) => this.logger.error(`${name} failed: ${err.message}`)),
          ms,
        ),
      );
    every(60 * 60 * 1000, 'expire unpaid enrollments', () => this.enrollments.expireUnpaid());
    every(60 * 1000, 'reconcile PENDING enrollments', () => this.enrollments.reconcilePending());
  }

  onApplicationShutdown(): void {
    this.timers.forEach(clearInterval);
  }
}
