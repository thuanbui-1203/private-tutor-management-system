import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  currentPeriod,
  enqueueEvent,
  nextPeriod,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import { AttendanceStatus, Period } from '@tms/contracts';
import { z } from 'zod';
import type { Prisma, Session } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly } from '../schedules/calendar';
import { editWindowHours, view } from '../sessions/sessions.service';
import { StudentClient } from '../sessions/student.client';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
const HOUR = 3_600_000;

export const AttendanceInput = z.object({
  /** One entry per Student on the Roster that day (plus anyone already recorded). */
  records: z
    .array(
      z.object({
        studentId: z.uuid(),
        /** EXCUSED is the Tutor's call; no 24h-notice check (BR-SC-08). */
        status: AttendanceStatus,
        note: z.string().trim().max(500).optional(),
      }),
    )
    .refine((r) => new Set(r.map((x) => x.studentId)).size === r.length, {
      message: 'each student at most once',
    }),
});
export type AttendanceInput = z.infer<typeof AttendanceInput>;

export const HistoryQuery = z.object({ month: Period.optional() });
export type HistoryQuery = z.infer<typeof HistoryQuery>;

/** Attendance: docs/01 §3.4, docs/diagrams/08-sequence-attendance-billing.puml (Schedule side). */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentClient,
  ) {}

  /** GET /sessions/{id}/attendance: the day's Roster with each Student's current status (Tutor's sheet). */
  async sheet(actor: AuthUser, sessionId: string) {
    const s = await this.owned(this.prisma, actor, sessionId);
    const [roster, recorded] = await Promise.all([
      this.rosterOn(this.prisma, s),
      this.prisma.attendance.findMany({ where: { sessionId } }),
    ]);
    const byStudent = new Map(recorded.map((a) => [a.studentId, a]));
    const names = new Map(roster.map((r) => [r.studentId, r.studentName]));
    const ids = [...new Set([...roster.map((r) => r.studentId), ...byStudent.keys()])];
    return {
      session: view(s),
      editableUntil: this.deadline(s).toISOString(),
      students: ids.map((studentId) => ({
        studentId,
        studentName: names.get(studentId) ?? null,
        status: byStudent.get(studentId)?.status ?? null,
        note: byStudent.get(studentId)?.note ?? null,
      })),
    };
  }

  /**
   * PUT /sessions/{id}/attendance. First save: the Session becomes COMPLETED and each Student
   * gets AttendanceRecorded. Later saves (until 48h after the end) are corrections:
   * AttendanceCorrected for each changed status (BR-SC-03).
   */
  async record(actor: AuthUser, sessionId: string, input: AttendanceInput, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      // Serialise saves of the same Session: two Tutors' tabs must not both "record first".
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM sessions WHERE id = $1::uuid FOR UPDATE',
        sessionId,
      );
      const s = await this.owned(tx, actor, sessionId);
      this.checkOpen(s, now);

      const existing = await tx.attendance.findMany({ where: { sessionId } });
      const previous = new Map(existing.map((a) => [a.studentId, a]));
      const expected = new Set([
        ...(await this.rosterOn(tx, s)).map((r) => r.studentId),
        ...previous.keys(),
      ]);
      const given = new Set(input.records.map((r) => r.studentId));
      const missing = [...expected].filter((id) => !given.has(id));
      const unknown = [...given].filter((id) => !expected.has(id));
      if (missing.length || unknown.length) {
        throw new UnprocessableEntityException({
          message: 'records must list every Student on the Roster that day, and only them',
          missing,
          unknown,
        });
      }

      const date = dateOnly(s.date);
      const base = { sessionId, classId: s.classId, date };
      for (const r of input.records) {
        const before = previous.get(r.studentId);
        const note = r.note || null;
        if (!before) {
          await tx.attendance.create({
            data: {
              sessionId,
              studentId: r.studentId,
              status: r.status,
              note,
              recordedBy: actor.id,
            },
          });
          await enqueueEvent(exec(tx), 'AttendanceRecorded', {
            ...base,
            studentId: r.studentId,
            status: r.status,
          });
        } else if (before.status !== r.status || before.note !== note) {
          await tx.attendance.update({
            where: { sessionId_studentId: { sessionId, studentId: r.studentId } },
            data: { status: r.status, note, recordedBy: actor.id },
          });
          if (before.status !== r.status) {
            await enqueueEvent(exec(tx), 'AttendanceCorrected', {
              ...base,
              studentId: r.studentId,
              oldStatus: before.status,
              newStatus: r.status,
            });
          }
        }
      }
      const done =
        s.status === 'COMPLETED'
          ? s
          : await tx.session.update({ where: { id: sessionId }, data: { status: 'COMPLETED' } });
      return {
        session: view(done),
        corrected: existing.length > 0,
        records: input.records.map(({ studentId, status, note }) => ({
          studentId,
          status,
          note: note || null,
        })),
      };
    });
  }

  /**
   * GET /students/{id}/attendance?month=YYYY-MM. Only this Student's records, never the
   * rest of a Group Class (BR-SC-10); a Tutor sees only their own Sessions.
   */
  async history(actor: AuthUser, studentId: string, q: HistoryQuery) {
    if (actor.role === 'PARENT' || actor.role === 'STUDENT') {
      const relation = await this.relation(studentId, actor.id);
      if (!relation || relation === 'tutor') throw new NotFoundException('student not found');
    }
    const month = q.month ?? currentPeriod();
    const rows = await this.prisma.attendance.findMany({
      where: {
        studentId,
        session: {
          date: {
            gte: new Date(`${month}-01T00:00:00Z`),
            lt: new Date(`${nextPeriod(month)}-01T00:00:00Z`),
          },
          ...(actor.role === 'TUTOR' && { tutorId: actor.id }),
        },
      },
      include: { session: true },
      orderBy: { session: { startsAt: 'asc' } },
    });
    if (actor.role === 'TUTOR' && rows.length === 0) {
      // Do not reveal whether the Student exists for another Tutor.
      const relation = await this.relation(studentId, actor.id).catch(() => null);
      if (relation !== 'tutor') throw new NotFoundException('student not found');
    }
    const summary = Object.fromEntries(AttendanceStatus.options.map((st) => [st, 0])) as Record<
      AttendanceStatus,
      number
    >;
    for (const r of rows) summary[r.status]++;
    return {
      studentId,
      month,
      summary,
      records: rows.map(({ session: s, status, note }) => ({
        sessionId: s.id,
        classId: s.classId,
        date: dateOnly(s.date),
        startTime: s.startTime,
        endTime: s.endTime,
        status,
        note,
      })),
    };
  }

  // ---------------------------------------------------------------- helpers

  /** BR-SC-09 and BR-SC-03: recording / correcting closes 48h after the Session ends. */
  private deadline(s: Session) {
    return new Date(s.endsAt.getTime() + editWindowHours() * HOUR);
  }

  /** BR-SC-02: only once started; never for cancelled or moved Sessions; locked after the window. */
  private checkOpen(s: Session, now: Date) {
    if (s.status === 'CANCELLED' || s.status === 'RESCHEDULED') {
      throw new ConflictException(`the session is ${s.status}`);
    }
    if (now < s.startsAt) {
      throw new ConflictException('the session has not started yet (BR-SC-02)');
    }
    if (now > this.deadline(s)) {
      throw new ConflictException(
        `attendance is locked ${editWindowHours()}h after the session ends (BR-SC-03, BR-SC-09)`,
      );
    }
  }

  /** Students on the Class Roster on the Session's date. */
  private rosterOn(db: Tx | PrismaService, s: Session) {
    return db.rosterEntry.findMany({
      where: {
        classId: s.classId,
        joinedAt: { lte: s.date },
        OR: [{ leftAt: null }, { leftAt: { gt: s.date } }],
      },
      orderBy: { studentName: 'asc' },
    });
  }

  private async owned(db: Tx | PrismaService, actor: AuthUser, id: string) {
    const s = await db.session.findUnique({ where: { id } });
    if (!s || (actor.role !== 'ADMIN' && s.tutorId !== actor.id)) {
      throw new NotFoundException('session not found');
    }
    return s;
  }

  private async relation(studentId: string, userId: string) {
    try {
      return await this.students.relation(studentId, userId);
    } catch {
      throw new ServiceUnavailableException('student service unavailable; try again shortly');
    }
  }
}
