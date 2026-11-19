import { Body, Controller, Module, Post } from '@nestjs/common';
import { Public, ZodBody } from '@tms/common';
import { z } from 'zod';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { EnrollmentsService } from '../enrollments/enrollments.service';

const Now = z.object({ now: z.iso.datetime() });

/**
 * End-to-end test hooks (#21): run the periodic jobs at a chosen instant, so a test can
 * "advance the clock" without waiting. Mounted only when E2E_HOOKS=true (the e2e compose
 * overlay); the gateway never routes /internal/**.
 */
@Public()
@Controller('internal/test')
class E2eHooksController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Post('jobs')
  async jobs(@Body(new ZodBody(Now)) body: z.infer<typeof Now>) {
    const now = new Date(body.now);
    return {
      expired: await this.enrollments.expireUnpaid(now),
      reconciled: await this.enrollments.reconcilePending(now),
    };
  }
}

@Module({ imports: [EnrollmentsModule], controllers: [E2eHooksController] })
export class E2eHooksModule {}
