import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { RosterService } from './roster.service';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

/** Weekly: extend every open Schedule to the 3-month horizon. */
@Injectable()
class ScheduleJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ScheduleJobs.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly schedules: SchedulesService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const run = () =>
      void this.schedules
        .extend()
        .catch((err) => this.logger.error(`extend failed: ${err.message}`));
    this.timer = setInterval(run, 24 * 60 * 60 * 1000); // daily; idempotent, so weekly is the minimum
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

@Module({
  controllers: [SchedulesController],
  providers: [SchedulesService, RosterService, ScheduleJobs],
  exports: [SchedulesService],
})
export class SchedulesModule {}
