import { Body, Controller, Module, NotFoundException, Post } from '@nestjs/common';
import { Public, ZodBody } from '@tms/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulesModule } from '../schedules/schedules.module';
import { SchedulesService } from '../schedules/schedules.service';
import { view } from '../sessions/sessions.service';

const At = z.object({
  classId: z.uuid(),
  startsAt: z.iso.datetime(),
  minutes: z.number().int().min(15).max(300).default(90),
});

/** Vietnam local `YYYY-MM-DD` and `HH:MM` of an instant (UTC+7, no DST). */
const local = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString();

/**
 * End-to-end test hook (#21): a Session at any instant, including one already under way
 * (the API only schedules the future). Publishes SessionScheduled like any other Session.
 * Mounted only when E2E_HOOKS=true; never routed by the gateway.
 */
@Public()
@Controller('internal/test')
class E2eHooksController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('sessions')
  async session(@Body(new ZodBody(At)) body: z.infer<typeof At>) {
    const cls = await this.prisma.classView.findUnique({ where: { classId: body.classId } });
    if (!cls) throw new NotFoundException('class not synced yet');
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(startsAt.getTime() + body.minutes * 60_000);
    const [session] = await this.prisma.$transaction((tx) =>
      this.schedules.insertSessions(tx, { classId: cls.classId, tutorId: cls.tutorId }, [
        {
          date: local(startsAt).slice(0, 10),
          startTime: local(startsAt).slice(11, 16),
          endTime: local(endsAt).slice(11, 16),
          startsAt,
          endsAt,
        },
      ]),
    );
    return view(session);
  }
}

@Module({ imports: [SchedulesModule], controllers: [E2eHooksController] })
export class E2eHooksModule {}
