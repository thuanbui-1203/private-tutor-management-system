import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulesModule } from '../schedules/schedules.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { StudentClient } from './student.client';

/** Hourly: Sessions 24h past their end without Attendance become MISSED (BR-SC-06). */
@Injectable()
class SessionJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SessionJobs.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly sessions: SessionsService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const run = () =>
      void this.sessions
        .markMissed()
        .then((n) => n && this.logger.log(`${n} session(s) marked MISSED`))
        .catch((err) => this.logger.error(`markMissed failed: ${err.message}`));
    this.timer = setInterval(run, 60 * 60 * 1000);
    run();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

@Module({
  imports: [SchedulesModule],
  controllers: [SessionsController],
  providers: [SessionsService, StudentClient, SessionJobs],
  exports: [SessionsService],
})
export class SessionsModule {}
