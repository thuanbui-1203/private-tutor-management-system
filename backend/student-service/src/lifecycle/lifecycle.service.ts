import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { enqueueEvent, recordChange, type AuthUser, type SqlExecutor } from '@tms/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STUDENT_PERSONAL, StudentsService, viewFor } from '../students/students.service';
import {
  checkTransition,
  OPEN_INVOICES_CHECKER,
  PAUSE_LIMIT_DAYS,
  type OpenInvoicesChecker,
  type StudentStatus,
} from './lifecycle';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;

@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    @Inject(OPEN_INVOICES_CHECKER) private readonly invoices: OpenInvoicesChecker,
  ) {}

  /** POST /students/{id}/status. Publishes StudentStatusChanged (Class reacts, BR-ST-03). */
  async changeStatus(actor: AuthUser, id: string, to: StudentStatus) {
    const current = await this.students.staffRecord(actor, id);
    checkTransition(current.status, to);
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, id, current.status, to, new Date());
      return tx.student.findUniqueOrThrow({
        where: { id },
        include: { parents: { include: { parent: true }, orderBy: { isPrimary: 'desc' } } },
      });
    });
    return viewFor(updated, 'staff');
  }

  /**
   * BR-ST-02: Students PAUSED for more than 60 days become DROPPED. `now` is a
   * parameter so tests can move the clock; returns how many were dropped.
   */
  async dropLongPaused(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - PAUSE_LIMIT_DAYS * DAY_MS);
    const due = await this.prisma.student.findMany({
      where: { status: 'PAUSED', statusChangedAt: { lt: cutoff }, anonymisedAt: null },
      select: { id: true },
    });
    for (const { id } of due) {
      await this.prisma.$transaction((tx) => this.transition(tx, id, 'PAUSED', 'DROPPED', now));
    }
    if (due.length)
      this.logger.log(`dropped ${due.length} Student(s) paused over ${PAUSE_LIMIT_DAYS} days`);
    return due.length;
  }

  /**
   * DELETE /students/{id} (Admin): Anonymisation, never a hard delete (BR-ST-08). Only
   * for DROPPED / GRADUATED Students whose Invoices are all PAID or VOID. Personal data
   * is erased; the id stays, so Billing's money records keep pointing at it.
   */
  async anonymise(actor: AuthUser, id: string): Promise<{ id: string; anonymisedAt: Date }> {
    const student = await this.students.staffRecord(actor, id);
    if (student.status !== 'DROPPED' && student.status !== 'GRADUATED') {
      throw new ConflictException(
        'only a DROPPED or GRADUATED Student can be anonymised (BR-ST-08)',
      );
    }
    const open = await this.invoices.openInvoiceIds(id);
    if (open.length > 0) {
      throw new ConflictException({
        message: 'settle every Invoice (PAID or VOID) before anonymising (BR-ST-08)',
        openInvoiceIds: open,
      });
    }

    const pseudonym = `Học sinh ${id.slice(0, 8)}`;
    const anonymisedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Parents who belong to no other Student are erased too.
      for (const { parentId } of student.parents) {
        const others = await tx.studentParent.count({
          where: { parentId, studentId: { not: id } },
        });
        if (others === 0) {
          await recordChange(tx as unknown as SqlExecutor, {
            action: 'parent.anonymise',
            entityType: 'Parent',
            entityId: parentId,
            after: { anonymised: true },
          });
          await tx.parent.update({
            where: { id: parentId },
            data: {
              fullName: 'Phụ huynh đã ẩn danh',
              phone: '0000000000',
              email: null,
              userId: null,
            },
          });
        }
      }
      await tx.studentParent.deleteMany({ where: { studentId: id } });
      await recordChange(tx as unknown as SqlExecutor, {
        action: 'student.anonymise',
        entityType: 'Student',
        entityId: id,
        before: { anonymisedAt: null },
        after: { anonymisedAt },
        personal: STUDENT_PERSONAL,
      });
      await tx.student.update({
        where: { id },
        data: {
          fullName: pseudonym,
          email: null,
          school: null,
          grade: null,
          note: null,
          dob: new Date('1900-01-01T00:00:00Z'),
          userId: null,
          anonymisedAt,
        },
      });
      // Billing's snapshot of the name and Payer contact is replaced with the pseudonym.
      await enqueueEvent(tx as unknown as SqlExecutor, 'StudentUpdated', {
        studentId: id,
        fullName: pseudonym,
        tutorId: student.tutorId,
        payerContact: { name: pseudonym, email: `anonymised-${id}@example.invalid` },
      });
    });
    return { id, anonymisedAt };
  }

  private async transition(tx: Tx, id: string, from: StudentStatus, to: StudentStatus, at: Date) {
    await tx.student.update({ where: { id }, data: { status: to, statusChangedAt: at } });
    // Actor: the Tutor / Admin on POST /students/{id}/status, SYSTEM for the BR-ST-02 job.
    await recordChange(tx as unknown as SqlExecutor, {
      action: 'student.change-status',
      entityType: 'Student',
      entityId: id,
      before: { status: from },
      after: { status: to },
    });
    await enqueueEvent(tx as unknown as SqlExecutor, 'StudentStatusChanged', {
      studentId: id,
      from,
      to,
    });
  }

  /** Runs the BR-ST-02 job hourly (it is idempotent, so the exact time does not matter). */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(
      () =>
        void this.dropLongPaused().catch((err) =>
          this.logger.error(`pause job failed: ${err.message}`),
        ),
      60 * 60 * 1000,
    );
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}
