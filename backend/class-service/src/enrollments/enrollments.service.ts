import {
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { enqueueEvent, todayInVietnam, type AuthUser, type SqlExecutor } from '@tms/common';
import type { EventEnvelope, InternalStudentResponse, WithdrawReason } from '@tms/contracts';
import type { Class, Enrollment, Prisma } from '../generated/prisma/client';
import { ClassesService, SEAT_HOLDING } from '../classes/classes.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentClient } from './student.client';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;
const DAY_MS = 86_400_000;
/** BR-CL-07 */
export const PAYMENT_WINDOW_DAYS = 7;
/** A PENDING enrollment whose Student cannot be confirmed within a day is rejected. */
export const PENDING_TIMEOUT_MS = DAY_MS;
const LIVE = ['PENDING', 'AWAITING_PAYMENT', 'ACTIVE', 'PAUSED'] as const;
const PLACEHOLDER_NAME = '(đang xác minh)';

export interface EnrollResult {
  httpStatus: HttpStatus.CREATED | HttpStatus.ACCEPTED;
  enrollment: Enrollment;
}

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classes: ClassesService,
    private readonly students: StudentClient,
  ) {}

  /**
   * POST /classes/{id}/enrollments (docs/diagrams/07-sequence-enrollment-saga.puml).
   * 201 ACTIVE (PER_SESSION) or AWAITING_PAYMENT (MONTHLY); 202 PENDING when
   * student-service cannot answer; 409 full / closed / already enrolled; 422 invalid Student.
   */
  async enroll(actor: AuthUser, classId: string, studentId: string): Promise<EnrollResult> {
    const cls = await this.classes.owned(actor, classId);
    this.checkOpen(cls);
    const existing = await this.prisma.enrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
    });
    if (existing && (LIVE as readonly string[]).includes(existing.status)) {
      throw new ConflictException('this Student is already enrolled in the class (BR-CL-03)');
    }

    const lookup = await this.students.lookup(studentId);
    if (lookup.kind === 'not-found') throw new UnprocessableEntityException('unknown Student');
    if (lookup.kind === 'found') this.checkStudent(cls, lookup.student);

    const enrollment = await this.prisma.$transaction(async (tx) => {
      await this.lockSeat(tx, cls);
      const data =
        lookup.kind === 'found'
          ? this.admitted(cls, lookup.student.fullName)
          : { status: 'PENDING' as const, studentName: PLACEHOLDER_NAME, paymentDeadline: null };
      const saved = existing
        ? await tx.enrollment.update({
            where: { id: existing.id },
            data: {
              ...data,
              withdrawReason: null,
              leftAt: null,
              rosterConfirmedAt: null,
              joinedAt: new Date(),
            },
          })
        : await tx.enrollment.create({ data: { classId, studentId, ...data } });
      if (saved.status !== 'PENDING') await this.publishEnrolled(tx, cls, saved);
      return saved;
    });
    return {
      httpStatus: enrollment.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.CREATED,
      enrollment,
    };
  }

  /** PATCH /classes/{id}/enrollments/{eid}: pause, resume or withdraw (reason REQUESTED). */
  async change(
    actor: AuthUser,
    classId: string,
    id: string,
    to: 'ACTIVE' | 'PAUSED' | 'WITHDRAWN',
  ) {
    await this.classes.owned(actor, classId);
    const e = await this.prisma.enrollment.findFirst({ where: { id, classId } });
    if (!e) throw new NotFoundException('enrollment not found');
    const allowed =
      (to === 'PAUSED' && e.status === 'ACTIVE') ||
      (to === 'ACTIVE' && e.status === 'PAUSED') ||
      (to === 'WITHDRAWN' && (LIVE as readonly string[]).includes(e.status));
    if (!allowed) throw new ConflictException(`a ${e.status} enrollment cannot become ${to}`);
    return this.prisma.$transaction(async (tx) =>
      to === 'WITHDRAWN'
        ? this.withdraw(tx, e, 'REQUESTED')
        : tx.enrollment.update({ where: { id }, data: { status: to } }),
    );
  }

  /** GET /students/{studentId}/classes: Tutors see their own classes, Parents / the Student all. */
  async classesOf(actor: AuthUser, studentId: string) {
    if (actor.role === 'PARENT' || actor.role === 'STUDENT') {
      const relation = await this.students.relation(studentId, actor.id);
      if (!relation || relation === 'tutor') throw new NotFoundException('student not found');
    }
    const rows = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        status: { in: [...LIVE] },
        ...(actor.role === 'TUTOR' && { class: { tutorId: actor.id } }),
      },
      include: {
        class: {
          select: { id: true, name: true, subject: true, type: true, feeType: true, tutorId: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
    if (actor.role === 'TUTOR' && rows.length === 0) {
      // Do not reveal whether the Student exists for another Tutor.
      const relation = await this.students.relation(studentId, actor.id).catch(() => null);
      if (relation !== 'tutor') throw new NotFoundException('student not found');
    }
    return rows.map(({ class: c, status, joinedAt, paymentDeadline, id }) => ({
      enrollmentId: id,
      status,
      joinedAt,
      paymentDeadline,
      class: c,
    }));
  }

  // ---------------------------------------------------------------- event handlers

  /** EnrollmentConfirmed: Schedule added the Student to the roster. */
  async onConfirmed(event: EventEnvelope<'EnrollmentConfirmed'>, tx: SqlExecutor) {
    await (tx as unknown as Tx).enrollment.updateMany({
      where: { id: event.data.enrollmentId, rosterConfirmedAt: null },
      data: { rosterConfirmedAt: new Date(event.occurredAt) },
    });
  }

  /** EnrollmentSyncFailed: compensate (REJECTED, seat released, StudentWithdrawn SYNC_FAILED). */
  async onSyncFailed(event: EventEnvelope<'EnrollmentSyncFailed'>, tx: SqlExecutor) {
    const t = tx as unknown as Tx;
    const e = await t.enrollment.findUnique({ where: { id: event.data.enrollmentId } });
    if (!e || !(LIVE as readonly string[]).includes(e.status)) return;
    await t.enrollment.update({
      where: { id: e.id },
      data: { status: 'REJECTED', withdrawReason: 'SYNC_FAILED', leftAt: new Date() },
    });
    await enqueueEvent(tx, 'StudentWithdrawn', {
      enrollmentId: e.id,
      classId: e.classId,
      studentId: e.studentId,
      reason: 'SYNC_FAILED',
    });
  }

  /** PaymentReceived for a fully paid Enrollment invoice: AWAITING_PAYMENT → ACTIVE (BR-CL-07). */
  async onPayment(event: EventEnvelope<'PaymentReceived'>, tx: SqlExecutor) {
    const { invoiceKind, invoiceStatus, enrollmentId } = event.data;
    if (invoiceKind !== 'ENROLLMENT' || invoiceStatus !== 'PAID' || !enrollmentId) return;
    await (tx as unknown as Tx).enrollment.updateMany({
      where: { id: enrollmentId, status: 'AWAITING_PAYMENT' },
      data: { status: 'ACTIVE', paymentDeadline: null },
    });
  }

  /** StudentStatusChanged (BR-ST-03): pause / resume, or withdraw when the Student leaves. */
  async onStudentStatus(event: EventEnvelope<'StudentStatusChanged'>, tx: SqlExecutor) {
    const t = tx as unknown as Tx;
    const { studentId, to } = event.data;
    if (to === 'PAUSED') {
      await t.enrollment.updateMany({
        where: { studentId, status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      });
    } else if (to === 'ACTIVE') {
      await t.enrollment.updateMany({
        where: { studentId, status: 'PAUSED' },
        data: { status: 'ACTIVE' },
      });
    } else {
      const live = await t.enrollment.findMany({ where: { studentId, status: { in: [...LIVE] } } });
      for (const e of live) await this.withdraw(t, e, 'STUDENT_STATUS');
    }
  }

  // ---------------------------------------------------------------- jobs (now injectable)

  /** BR-CL-07: AWAITING_PAYMENT past the 7-day deadline → WITHDRAWN (UNPAID), seat released. */
  async expireUnpaid(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.enrollment.findMany({
      where: { status: 'AWAITING_PAYMENT', paymentDeadline: { lt: now } },
    });
    for (const e of due) await this.prisma.$transaction((tx) => this.withdraw(tx, e, 'UNPAID'));
    if (due.length) this.logger.log(`withdrew ${due.length} unpaid enrollment(s)`);
    return due.length;
  }

  /** Re-checks PENDING enrollments with student-service; rejects them after a day. */
  async reconcilePending(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.enrollment.findMany({
      where: { status: 'PENDING' },
      include: { class: true },
    });
    let resolved = 0;
    for (const e of pending) {
      const lookup = await this.students.lookup(e.studentId);
      if (lookup.kind === 'unavailable') {
        if (now.getTime() - e.createdAt.getTime() > PENDING_TIMEOUT_MS) {
          await this.prisma.enrollment.update({
            where: { id: e.id },
            data: { status: 'REJECTED', leftAt: now },
          });
          resolved++;
        }
        continue;
      }
      const valid =
        lookup.kind === 'found' &&
        lookup.student.tutorId === e.class.tutorId &&
        lookup.student.status === 'ACTIVE';
      await this.prisma.$transaction(async (tx) => {
        if (!valid || e.class.status !== 'OPEN') {
          await tx.enrollment.update({
            where: { id: e.id },
            data: { status: 'REJECTED', leftAt: now },
          });
          return;
        }
        const saved = await tx.enrollment.update({
          where: { id: e.id },
          data: this.admitted(
            e.class,
            lookup.kind === 'found' ? lookup.student.fullName : e.studentName,
            now,
          ),
        });
        await this.publishEnrolled(tx, e.class, saved);
      });
      resolved++;
    }
    return resolved;
  }

  // ---------------------------------------------------------------- helpers

  private checkOpen(cls: Class) {
    if (cls.status !== 'OPEN') throw new ConflictException('the class is closed');
  }

  private checkStudent(cls: Class, student: InternalStudentResponse) {
    if (student.tutorId !== cls.tutorId) {
      throw new UnprocessableEntityException('the Student belongs to another Tutor');
    }
    if (student.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`a ${student.status} Student cannot be enrolled`);
    }
  }

  /** Locks the class row, then counts seats: two enrollments cannot take the last seat (BR-CL-01/02/06). */
  private async lockSeat(tx: Tx, cls: Class) {
    await tx.$queryRawUnsafe('SELECT id FROM classes WHERE id = $1::uuid FOR UPDATE', cls.id);
    const taken = await tx.enrollment.count({
      where: { classId: cls.id, status: { in: [...SEAT_HOLDING] } },
    });
    if (taken >= cls.maxStudents) throw new ConflictException('the class is full');
  }

  private admitted(cls: Class, studentName: string, now: Date = new Date()) {
    return cls.feeType === 'MONTHLY'
      ? {
          status: 'AWAITING_PAYMENT' as const,
          studentName,
          paymentDeadline: new Date(now.getTime() + PAYMENT_WINDOW_DAYS * DAY_MS),
        }
      : { status: 'ACTIVE' as const, studentName, paymentDeadline: null };
  }

  private publishEnrolled(tx: Tx, cls: Class, e: Enrollment) {
    return enqueueEvent(exec(tx), 'StudentEnrolled', {
      enrollmentId: e.id,
      classId: cls.id,
      studentId: e.studentId,
      studentName: e.studentName,
      feeType: cls.feeType,
      status: e.status as 'ACTIVE' | 'AWAITING_PAYMENT',
      joinedAt: todayInVietnam(),
    });
  }

  private async withdraw(tx: Tx, e: Enrollment, reason: WithdrawReason) {
    const saved = await tx.enrollment.update({
      where: { id: e.id },
      data: {
        status: 'WITHDRAWN',
        withdrawReason: reason,
        leftAt: new Date(),
        paymentDeadline: null,
      },
    });
    await enqueueEvent(exec(tx), 'StudentWithdrawn', {
      enrollmentId: e.id,
      classId: e.classId,
      studentId: e.studentId,
      reason,
    });
    return saved;
  }
}
