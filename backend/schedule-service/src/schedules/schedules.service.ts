import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  enqueueEvent,
  recordChange,
  todayInVietnam,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import { z } from 'zod';
import type { Prisma, Schedule, Session } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addMonths, dateOnly, plan, type PlannedSession } from './calendar';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
/** Sessions are generated this far ahead; the weekly job keeps the window full. */
export const HORIZON_MONTHS = 3;
/** Sessions that occupy the Tutor's time (BR-SC-01). */
export const BUSY = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'MISSED'] as const;

export const ScheduleInput = z
  .object({
    classId: z.uuid(),
    weekday: z.number().int().min(1).max(7),
    startTime: time,
    endTime: time,
    fromDate: z.iso.date(),
    toDate: z.iso.date().optional(),
    /** Create the non-conflicting Sessions and skip the rest, instead of refusing. */
    skipConflicts: z.boolean().default(false),
  })
  .refine((s) => s.startTime < s.endTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  })
  .refine((s) => !s.toDate || s.fromDate <= s.toDate, {
    message: 'toDate is before fromDate',
    path: ['toDate'],
  });
export type ScheduleInput = z.infer<typeof ScheduleInput>;

export interface Conflict {
  date: string;
  startTime: string;
  endTime: string;
  /** The Tutor's existing Session it overlaps. */
  conflictsWith: { sessionId: string; classId: string; startTime: string; endTime: string };
}

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** POST /schedules/preview: the Sessions that would be created and their conflicts. Writes nothing. */
  async preview(actor: AuthUser, input: ScheduleInput) {
    const cls = await this.ownedClass(actor, input.classId);
    const candidates = this.window(input, todayInVietnam());
    const conflicts = await this.conflicts(this.prisma, cls.tutorId, candidates);
    return {
      sessions: candidates.map(({ date, startTime, endTime }) => ({ date, startTime, endTime })),
      conflicts,
    };
  }

  /** POST /schedules: 409 with the conflicts unless skipConflicts (activity diagram 05). */
  async create(actor: AuthUser, input: ScheduleInput) {
    const cls = await this.ownedClass(actor, input.classId);
    const today = todayInVietnam();
    const candidates = this.window(input, today);
    return this.prisma.$transaction(async (tx) => {
      // Serialise schedule creation per Tutor so two requests cannot double-book them.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', cls.tutorId);
      const conflicts = await this.conflicts(tx, cls.tutorId, candidates);
      if (conflicts.length && !input.skipConflicts) {
        throw new ConflictException({
          message: "some Sessions overlap the Tutor's other Sessions (BR-SC-01)",
          conflicts,
        });
      }
      const clash = new Set(conflicts.map((c) => c.date));
      const schedule = await tx.schedule.create({
        data: {
          classId: input.classId,
          tutorId: cls.tutorId,
          weekday: input.weekday,
          startTime: input.startTime,
          endTime: input.endTime,
          fromDate: new Date(`${input.fromDate}T00:00:00Z`),
          toDate: input.toDate ? new Date(`${input.toDate}T00:00:00Z`) : null,
          generatedUntil: new Date(`${this.until(input, today)}T00:00:00Z`),
        },
      });
      const created = await this.insertSessions(
        tx,
        schedule,
        candidates.filter((c) => !clash.has(c.date)),
      );
      await recordChange(tx as unknown as SqlExecutor, {
        action: 'schedule.create',
        entityType: 'Schedule',
        entityId: schedule.id,
        after: { ...schedule, sessionIds: created.map((c) => c.id) },
      });
      return { schedule, sessionsCreated: created.length, skipped: conflicts };
    });
  }

  list(actor: AuthUser, classId?: string) {
    return this.prisma.schedule.findMany({
      where: { ...(actor.role !== 'ADMIN' && { tutorId: actor.id }), ...(classId && { classId }) },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  }

  /** DELETE /schedules/{id}: ends the Schedule and cancels its future Sessions (BR-SC-07). */
  async end(actor: AuthUser, id: string) {
    const schedule = await this.prisma.schedule.findUnique({ where: { id } });
    if (!schedule || (actor.role !== 'ADMIN' && schedule.tutorId !== actor.id)) {
      throw new NotFoundException('schedule not found');
    }
    if (schedule.endedAt) throw new ConflictException('the schedule has already ended');
    return this.prisma.$transaction(async (tx) => {
      const ended = await tx.schedule.update({ where: { id }, data: { endedAt: new Date() } });
      const cancelled = await this.cancelFuture(
        tx,
        { scheduleId: id },
        'Lịch lặp đã kết thúc',
        actor.id,
      );
      await recordChange(tx as unknown as SqlExecutor, {
        action: 'schedule.end',
        entityType: 'Schedule',
        entityId: id,
        before: schedule,
        after: { ...ended, sessionsCancelled: cancelled },
      });
      return { schedule: ended, sessionsCancelled: cancelled };
    });
  }

  /** Weekly: keep every open Schedule generated HORIZON_MONTHS ahead (conflicting dates skipped). */
  async extend(now: Date = new Date()): Promise<number> {
    const today = todayInVietnam(now);
    const horizon = addMonths(today, HORIZON_MONTHS);
    const open = await this.prisma.schedule.findMany({ where: { endedAt: null } });
    let added = 0;
    for (const s of open) {
      const toDate = s.toDate ? dateOnly(s.toDate) : undefined;
      const until = toDate && toDate < horizon ? toDate : horizon;
      const from = dateOnly(new Date(s.generatedUntil.getTime() + 86_400_000));
      if (from > until) continue;
      added += await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', s.tutorId);
        const candidates = plan(s.weekday, s.startTime, s.endTime, from, until);
        const clash = new Set((await this.conflicts(tx, s.tutorId, candidates)).map((c) => c.date));
        const created = await this.insertSessions(
          tx,
          s,
          candidates.filter((c) => !clash.has(c.date)),
        );
        await tx.schedule.update({
          where: { id: s.id },
          data: { generatedUntil: new Date(`${until}T00:00:00Z`) },
        });
        if (clash.size)
          this.logger.warn(`schedule ${s.id}: skipped ${clash.size} conflicting date(s)`);
        return created.length;
      });
    }
    return added;
  }

  // ---------------------------------------------------------------- shared with #14

  /** The Tutor's busy Sessions overlapping any candidate (BR-SC-01). */
  async conflicts(
    db: Tx | PrismaService,
    tutorId: string,
    candidates: PlannedSession[],
    ignoreSessionId?: string,
  ): Promise<Conflict[]> {
    if (candidates.length === 0) return [];
    const busy = await db.session.findMany({
      where: {
        tutorId,
        status: { in: [...BUSY] },
        startsAt: { lt: candidates[candidates.length - 1].endsAt },
        endsAt: { gt: candidates[0].startsAt },
        ...(ignoreSessionId && { id: { not: ignoreSessionId } }),
      },
    });
    const out: Conflict[] = [];
    for (const c of candidates) {
      const hit = busy.find((b) => b.startsAt < c.endsAt && b.endsAt > c.startsAt);
      if (hit) {
        out.push({
          date: c.date,
          startTime: c.startTime,
          endTime: c.endTime,
          conflictsWith: {
            sessionId: hit.id,
            classId: hit.classId,
            startTime: hit.startTime,
            endTime: hit.endTime,
          },
        });
      }
    }
    return out;
  }

  /** Creates Sessions and publishes SessionScheduled for each, with the current roster. */
  async insertSessions(
    tx: Tx,
    owner: { id?: string | null; classId: string; tutorId: string },
    sessions: PlannedSession[],
    makeupOf?: string,
  ): Promise<Session[]> {
    const roster = await this.roster(tx, owner.classId);
    const created: Session[] = [];
    for (const s of sessions) {
      const session = await this.createSession(tx, owner, s, makeupOf);
      await enqueueEvent(exec(tx), 'SessionScheduled', {
        sessionId: session.id,
        classId: owner.classId,
        startAt: s.startsAt.toISOString(),
        studentIds: roster,
      });
      created.push(session);
    }
    return created;
  }

  /** Inserts one Session without publishing anything (a reschedule publishes its own event). */
  createSession(
    tx: Tx,
    owner: { id?: string | null; classId: string; tutorId: string },
    s: PlannedSession,
    makeupOf?: string,
  ): Promise<Session> {
    return tx.session.create({
      data: {
        scheduleId: owner.id ?? null,
        classId: owner.classId,
        tutorId: owner.tutorId,
        date: new Date(`${s.date}T00:00:00Z`),
        startTime: s.startTime,
        endTime: s.endTime,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        makeupOf: makeupOf ?? null,
      },
    });
  }

  /** Cancels future SCHEDULED Sessions matching `where`; SessionCancelled for each. */
  async cancelFuture(
    tx: Tx,
    where: Prisma.SessionWhereInput,
    reason: string,
    cancelledBy: string,
  ): Promise<number> {
    const future = await tx.session.findMany({
      where: { ...where, status: 'SCHEDULED', startsAt: { gt: new Date() } },
    });
    for (const s of future) {
      await tx.session.update({
        where: { id: s.id },
        data: { status: 'CANCELLED', cancelReason: reason },
      });
      await enqueueEvent(exec(tx), 'SessionCancelled', { sessionId: s.id, reason, cancelledBy });
    }
    return future.length;
  }

  async roster(db: Tx | PrismaService, classId: string): Promise<string[]> {
    const rows = await db.rosterEntry.findMany({
      where: { classId, leftAt: null },
      select: { studentId: true },
    });
    return rows.map((r) => r.studentId);
  }

  /** The local Class copy, if the caller owns it (or is Admin) and it is open. */
  async ownedClass(actor: AuthUser, classId: string) {
    const cls = await this.prisma.classView.findUnique({ where: { classId } });
    if (!cls) {
      throw new ConflictException(
        'this class has not reached the schedule service yet; try again in a moment',
      );
    }
    if (actor.role !== 'ADMIN' && cls.tutorId !== actor.id)
      throw new NotFoundException('class not found');
    if (!cls.open) throw new UnprocessableEntityException('the class is closed');
    return cls;
  }

  private until(input: ScheduleInput, today: string): string {
    const horizon = addMonths(today > input.fromDate ? today : input.fromDate, HORIZON_MONTHS);
    return input.toDate && input.toDate < horizon ? input.toDate : horizon;
  }

  /** Candidate Sessions from max(today, fromDate) up to the horizon / toDate. */
  private window(input: ScheduleInput, today: string): PlannedSession[] {
    const from = today > input.fromDate ? today : input.fromDate;
    return plan(
      input.weekday,
      input.startTime,
      input.endTime,
      from,
      this.until(input, today),
    ).filter((s) => s.startsAt > new Date());
  }
}

export type { Schedule };
