import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
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
import type { Prisma, Session, SessionStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, dateOnly, toInstant, type PlannedSession } from '../schedules/calendar';
import { SchedulesService } from '../schedules/schedules.service';
import { StudentClient } from './student.client';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
const HOUR = 3_600_000;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** A Tutor may open a Session this long before it starts (state diagram: "trong khung giờ học"). */
export const START_EARLY_MINUTES = 15;
/** BR-SC-06: no Attendance this long after the end → MISSED. */
export const MISSED_AFTER_HOURS = 24;
/** BR-SC-09: a MISSED Session can still be handled (attendance, cancel) this long after its end. */
export const editWindowHours = () => Number(process.env.ATTENDANCE_EDIT_WINDOW_HOURS ?? 48);

const Slot = z
  .object({ date: z.iso.date(), startTime: time, endTime: time })
  .refine((s) => s.startTime < s.endTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export const SessionInput = z
  .object({
    classId: z.uuid(),
    date: z.iso.date(),
    startTime: time,
    endTime: time,
    /** Makeup session: the CANCELLED / MISSED Session it replaces (BR-SC-05). */
    makeupOf: z.uuid().optional(),
  })
  .refine((s) => s.startTime < s.endTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });
export type SessionInput = z.infer<typeof SessionInput>;

export const RescheduleInput = Slot;
export type RescheduleInput = z.infer<typeof RescheduleInput>;

export const CancelInput = z.object({ reason: z.string().trim().min(1).max(500) });
export type CancelInput = z.infer<typeof CancelInput>;

export const SessionQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    classId: z.uuid().optional(),
    /** Required for PARENT / STUDENT: whose Sessions to show. */
    studentId: z.uuid().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'to is before from',
    path: ['to'],
  });
export type SessionQuery = z.infer<typeof SessionQuery>;
/** The longest window GET /sessions returns (a quarter). */
const MAX_RANGE_DAYS = 93;

export interface SessionView {
  id: string;
  classId: string;
  scheduleId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  status: SessionStatus;
  makeupOf: string | null;
  cancelReason: string | null;
}

export const view = (s: Session): SessionView => ({
  id: s.id,
  classId: s.classId,
  scheduleId: s.scheduleId,
  date: dateOnly(s.date),
  startTime: s.startTime,
  endTime: s.endTime,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  status: s.status,
  makeupOf: s.makeupOf,
  cancelReason: s.cancelReason,
});

const planned = (date: string, startTime: string, endTime: string): PlannedSession => ({
  date,
  startTime,
  endTime,
  startsAt: toInstant(date, startTime),
  endsAt: toInstant(date, endTime),
});

/** Session state changes: docs/diagrams/09-state-lifecycle.puml (Session), docs/01 §4.4. */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly students: StudentClient,
  ) {}

  /** POST /sessions: a one-off Session, or a Makeup session when `makeupOf` is set. */
  async create(actor: AuthUser, input: SessionInput, now = new Date()) {
    const cls = await this.schedules.ownedClass(actor, input.classId);
    const slot = this.futureSlot(input, now);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTutor(tx, cls.tutorId);
      if (input.makeupOf) await this.checkMakeupTarget(tx, input.makeupOf, input.classId);
      await this.refuseConflicts(tx, cls.tutorId, slot);
      const [session] = await this.schedules.insertSessions(
        tx,
        { classId: cls.classId, tutorId: cls.tutorId },
        [slot],
        input.makeupOf,
      );
      await recordChange(exec(tx), {
        action: 'session.create',
        entityType: 'Session',
        entityId: session.id,
        after: session,
      });
      return view(session);
    });
  }

  /** SCHEDULED → IN_PROGRESS, only from 15 minutes before the start until the end. */
  async start(actor: AuthUser, id: string, now = new Date()) {
    const s = await this.owned(actor, id);
    this.expect(s, ['SCHEDULED']);
    if (now.getTime() < s.startsAt.getTime() - START_EARLY_MINUTES * 60_000 || now >= s.endsAt) {
      throw new UnprocessableEntityException(
        `a session can only be started from ${START_EARLY_MINUTES} minutes before it begins until it ends`,
      );
    }
    return view(
      await this.transition(
        'session.start',
        id,
        'SCHEDULED',
        { status: 'IN_PROGRESS' },
        async () => undefined,
      ),
    );
  }

  /** SCHEDULED / IN_PROGRESS / MISSED (within the edit window) → CANCELLED; nobody is charged (BR-SC-04). */
  async cancel(actor: AuthUser, id: string, input: CancelInput, now = new Date()) {
    const s = await this.owned(actor, id);
    this.expect(s, ['SCHEDULED', 'IN_PROGRESS', 'MISSED']);
    if (s.status === 'MISSED' && now.getTime() > s.endsAt.getTime() + editWindowHours() * HOUR) {
      throw new UnprocessableEntityException(
        `this missed session is locked (more than ${editWindowHours()}h after it ended, BR-SC-09)`,
      );
    }
    const cancelled = await this.transition(
      'session.cancel',
      id,
      s.status,
      { status: 'CANCELLED', cancelReason: input.reason },
      (tx) =>
        enqueueEvent(exec(tx), 'SessionCancelled', {
          sessionId: id,
          reason: input.reason,
          cancelledBy: actor.id,
        }),
    );
    return view(cancelled);
  }

  /**
   * SCHEDULED → RESCHEDULED plus a new Session at the new time (makeup_of = the old one).
   * Publishes exactly one SessionRescheduled: not a SessionCancelled + SessionScheduled pair.
   */
  async reschedule(actor: AuthUser, id: string, input: RescheduleInput, now = new Date()) {
    const s = await this.owned(actor, id);
    this.expect(s, ['SCHEDULED']);
    const slot = this.futureSlot(input, now);
    if (
      slot.startsAt.getTime() === s.startsAt.getTime() &&
      slot.endsAt.getTime() === s.endsAt.getTime()
    ) {
      throw new BadRequestException('the new time is the same as the current one');
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockTutor(tx, s.tutorId);
      await this.refuseConflicts(tx, s.tutorId, slot, id);
      const moved = await tx.session.updateMany({
        where: { id, status: 'SCHEDULED' },
        data: { status: 'RESCHEDULED' },
      });
      if (moved.count === 0) throw new ConflictException('the session changed; reload and retry');
      const next = await this.schedules.createSession(
        tx,
        { id: s.scheduleId, classId: s.classId, tutorId: s.tutorId },
        slot,
        id,
      );
      await enqueueEvent(exec(tx), 'SessionRescheduled', {
        oldSessionId: id,
        newSessionId: next.id,
        classId: s.classId,
        newStartAt: next.startsAt.toISOString(),
        studentIds: await this.schedules.roster(tx, s.classId),
      });
      await recordChange(exec(tx), {
        action: 'session.reschedule',
        entityType: 'Session',
        entityId: id,
        before: { status: s.status, startsAt: s.startsAt, endsAt: s.endsAt },
        after: { status: 'RESCHEDULED', newSessionId: next.id, newStartsAt: next.startsAt },
      });
      return { old: view({ ...s, status: 'RESCHEDULED' }), session: view(next) };
    });
  }

  /** GET /sessions: Tutors their own, Admin all, Parents / Students those of one Student. */
  async list(actor: AuthUser, q: SessionQuery) {
    const from = q.from ?? todayInVietnam();
    const to = q.to ?? addDays(from, 30);
    if (addDays(from, MAX_RANGE_DAYS) < to) {
      throw new BadRequestException(`at most ${MAX_RANGE_DAYS} days per request`);
    }
    const range = {
      gte: new Date(`${from}T00:00:00Z`),
      lte: new Date(`${to}T00:00:00Z`),
    };
    let scope: Prisma.SessionWhereInput;
    if (actor.role === 'ADMIN') scope = {};
    else if (actor.role === 'TUTOR') scope = { tutorId: actor.id };
    else scope = await this.studentScope(actor, q.studentId);
    const rows = await this.prisma.session.findMany({
      where: { AND: [scope, { date: range }, ...(q.classId ? [{ classId: q.classId }] : [])] },
      orderBy: [{ startsAt: 'asc' }],
    });
    return rows.map(view);
  }

  /** Hourly (BR-SC-06): SCHEDULED / IN_PROGRESS Sessions 24h past their end without Attendance → MISSED. */
  async markMissed(now = new Date()): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: {
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        endsAt: { lt: new Date(now.getTime() - MISSED_AFTER_HOURS * HOUR) },
      },
      data: { status: 'MISSED' },
    });
    return count;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * A Parent / Student sees the Sessions of the Classes the Student is (or was) on the Roster of,
   * only while they were enrolled. Sessions carry no other Student's data (BR-SC-10).
   */
  private async studentScope(actor: AuthUser, studentId?: string) {
    if (!studentId) throw new BadRequestException('studentId is required');
    let relation;
    try {
      relation = await this.students.relation(studentId, actor.id);
    } catch {
      throw new ServiceUnavailableException('student service unavailable; try again shortly');
    }
    if (!relation || relation === 'tutor') throw new NotFoundException('student not found');
    const memberships = await this.prisma.rosterEntry.findMany({ where: { studentId } });
    if (memberships.length === 0) return { id: { in: [] } } satisfies Prisma.SessionWhereInput;
    return {
      OR: memberships.map((m) => ({
        classId: m.classId,
        date: { gte: m.joinedAt, ...(m.leftAt && { lt: m.leftAt }) },
      })),
    } satisfies Prisma.SessionWhereInput;
  }

  private async owned(actor: AuthUser, id: string): Promise<Session> {
    const s = await this.prisma.session.findUnique({ where: { id } });
    if (!s || (actor.role !== 'ADMIN' && s.tutorId !== actor.id)) {
      throw new NotFoundException('session not found');
    }
    return s;
  }

  private expect(s: Session, allowed: SessionStatus[]) {
    if (!allowed.includes(s.status)) {
      throw new ConflictException(`not allowed while the session is ${s.status}`);
    }
  }

  /** Compare-and-set on the status, so two concurrent requests cannot both win. */
  private transition(
    action: string,
    id: string,
    from: SessionStatus,
    data: Prisma.SessionUpdateManyMutationInput,
    publish: (tx: Tx) => Promise<unknown>,
  ): Promise<Session> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({ where: { id, status: from }, data });
      if (count === 0) throw new ConflictException('the session changed; reload and retry');
      await publish(tx);
      const after = await tx.session.findUniqueOrThrow({ where: { id } });
      await recordChange(exec(tx), {
        action,
        entityType: 'Session',
        entityId: id,
        before: { status: from },
        after: {
          status: after.status,
          ...(data.cancelReason ? { cancelReason: after.cancelReason } : {}),
        },
      });
      return after;
    });
  }

  private futureSlot(s: { date: string; startTime: string; endTime: string }, now: Date) {
    const slot = planned(s.date, s.startTime, s.endTime);
    if (slot.startsAt <= now)
      throw new UnprocessableEntityException('the time must be in the future');
    return slot;
  }

  private lockTutor(tx: Tx, tutorId: string) {
    return tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', tutorId);
  }

  private async refuseConflicts(tx: Tx, tutorId: string, slot: PlannedSession, ignore?: string) {
    const conflicts = await this.schedules.conflicts(tx, tutorId, [slot], ignore);
    if (conflicts.length) {
      throw new ConflictException({
        message: "the time overlaps the Tutor's other Sessions (BR-SC-01)",
        conflicts,
      });
    }
  }

  /** BR-SC-05: a Makeup session replaces a CANCELLED / MISSED Session of the same Class, once. */
  private async checkMakeupTarget(tx: Tx, makeupOf: string, classId: string) {
    const original = await tx.session.findUnique({ where: { id: makeupOf } });
    if (!original || original.classId !== classId) {
      throw new UnprocessableEntityException('makeupOf must be a session of the same class');
    }
    if (original.status !== 'CANCELLED' && original.status !== 'MISSED') {
      throw new UnprocessableEntityException('only a cancelled or missed session can be made up');
    }
    const existing = await tx.session.findFirst({
      where: { makeupOf, status: { not: 'CANCELLED' } },
    });
    if (existing) {
      throw new ConflictException({
        message: 'this session already has a makeup session',
        sessionId: existing.id,
      });
    }
  }
}
