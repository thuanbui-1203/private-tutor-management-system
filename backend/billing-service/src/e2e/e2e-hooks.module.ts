import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { Public, ZodBody } from '@tms/common';
import { z } from 'zod';
import { CopiesModule } from '../copies/copies.module';
import { CopiesService } from '../copies/copies.service';
import { InvoicesModule } from '../invoices/invoices.module';
import { LifecycleService } from '../invoices/lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';

const Now = z.object({ now: z.iso.datetime() });
const Count = z.object({ classId: z.uuid(), from: z.iso.date(), to: z.iso.date() });

/**
 * End-to-end test hooks (#21): the month close at a chosen instant, and the Session count
 * Billing prorates with. Mounted only when E2E_HOOKS=true; never routed by the gateway.
 */
@Public()
@Controller('internal/test')
class E2eHooksController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly copies: CopiesService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('close-month')
  closeMonth(@Body(new ZodBody(Now)) body: z.infer<typeof Now>) {
    return this.lifecycle.closeMonth(new Date(body.now));
  }

  @Get('session-count')
  async sessionCount(@Query(new ZodBody(Count)) q: z.infer<typeof Count>) {
    return { count: await this.copies.countSessions(this.prisma, q.classId, q.from, q.to) };
  }
}

@Module({ imports: [InvoicesModule, CopiesModule], controllers: [E2eHooksController] })
export class E2eHooksModule {}
