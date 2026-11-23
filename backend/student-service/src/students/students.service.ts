import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { enqueueEvent, recordChange, type AuthUser, type SqlExecutor } from '@tms/common';
import type {
  Contact,
  InternalStudentAccessResponse,
  InternalStudentResponse,
} from '@tms/contracts';
import type { Parent, Prisma, Student, StudentParent } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityClient, type InvitationOutcome } from './identity.client';
import { checkPayer, checkSinglePrimary, isMinor, type PayerKind } from './rules';
import type { CreateStudent, ParentLink, UpdateStudent } from './schemas';

export type StudentRecord = Student & { parents: (StudentParent & { parent: Parent })[] };
type Tx = Prisma.TransactionClient;

/** Personal fields of a Student / Parent on top of @tms/common's PERSONAL_FIELDS (ADR-0005). */
export const STUDENT_PERSONAL = ['school'];

/** How the caller relates to a Student; decides what they may see (BR-ST-06, BR-ST-07). */
export type Relation = 'staff' | 'primary-parent' | 'secondary-parent' | 'self';

const WITH_PARENTS = {
  parents: { include: { parent: true }, orderBy: { isPrimary: 'desc' } },
} as const;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const primaryOf = (s: StudentRecord) => s.parents.find((p) => p.isPrimary)?.parent;

export function payerContact(student: StudentRecord): Contact {
  const primary = primaryOf(student);
  if (student.payer === 'PRIMARY_PARENT' && primary) {
    return {
      name: primary.fullName,
      phone: primary.phone,
      ...(primary.email && { email: primary.email }),
    };
  }
  return { name: student.fullName, ...(student.email && { email: student.email }) };
}

/** The Student as each kind of caller may see them. Unknown relation → never called (404 earlier). */
export function viewFor(student: StudentRecord, relation: Relation) {
  const seesBilling =
    relation === 'staff' ||
    relation === 'primary-parent' ||
    (relation === 'self' && student.payer === 'SELF');
  return {
    id: student.id,
    tutorId: student.tutorId,
    fullName: student.fullName,
    email: student.email,
    dob: dateOnly(student.dob),
    school: student.school,
    grade: student.grade,
    status: student.status,
    ...(relation === 'staff' && { note: student.note }),
    ...(seesBilling && { payer: student.payer, payerContact: payerContact(student) }),
    parents: student.parents.map(({ parent, isPrimary }) => ({
      id: parent.id,
      fullName: parent.fullName,
      isPrimary,
      ...((relation === 'staff' || relation === 'primary-parent') && {
        phone: parent.phone,
        email: parent.email,
      }),
    })),
  };
}

/** Which Parents are linked and who is primary: ids only, no personal data. */
const links = (s: StudentRecord) =>
  s.parents.map(({ parentId, isPrimary }) => ({ parentId, isPrimary }));

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityClient,
  ) {}

  async create(actor: AuthUser, body: CreateStudent) {
    const tutorId = actor.role === 'TUTOR' ? actor.id : body.tutorId;
    if (!tutorId)
      throw new BadRequestException('an Admin must say which Tutor the Student belongs to');
    checkSinglePrimary(body.parents);
    const hasPrimaryParent = body.parents.some((p) => p.isPrimary);
    const payer: PayerKind = body.payer ?? (hasPrimaryParent ? 'PRIMARY_PARENT' : 'SELF');
    checkPayer({ dob: body.dob, payer, hasPrimaryParent, email: body.email });

    const student = await this.prisma.$transaction(async (tx) => {
      const created = await tx.student.create({
        data: {
          tutorId,
          fullName: body.fullName,
          dob: new Date(`${body.dob}T00:00:00Z`),
          email: body.email,
          school: body.school,
          grade: body.grade,
          note: body.note,
          payer,
        },
      });
      for (const link of body.parents) await this.link(tx, actor, created.id, link);
      const full = await tx.student.findUniqueOrThrow({
        where: { id: created.id },
        include: WITH_PARENTS,
      });
      await this.publish(tx, 'StudentCreated', full);
      await recordChange(tx, {
        action: 'student.create',
        entityType: 'Student',
        entityId: full.id,
        after: full,
        personal: STUDENT_PERSONAL,
      });
      return full;
    });

    if (!body.invite) {
      return {
        ...viewFor(student, 'staff'),
        invitation: { status: 'skipped', reason: 'not requested' },
      };
    }
    const invitation = await this.sendInvitation(actor, student);
    const parentInvitation = await this.sendParentInvitation(actor, student);
    return {
      ...viewFor(student, 'staff'),
      invitation,
      ...(parentInvitation && { parentInvitation }),
    };
  }

  async list(
    actor: AuthUser,
    query: { status?: Student['status']; q?: string; page: number; pageSize: number },
  ) {
    const where: Prisma.StudentWhereInput = {
      ...(actor.role === 'TUTOR' && { tutorId: actor.id }),
      ...(query.status && { status: query.status }),
      ...(query.q && { fullName: { contains: query.q, mode: 'insensitive' } }),
      anonymisedAt: null,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        include: WITH_PARENTS,
        orderBy: { fullName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.student.count({ where }),
    ]);
    return {
      items: items.map((s) => viewFor(s, 'staff')),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** GET /students/me: the Student linked to this account (after accepting their Invitation). */
  async me(actor: AuthUser) {
    const student = await this.prisma.student.findFirst({
      where: { userId: actor.id, anonymisedAt: null },
      include: WITH_PARENTS,
    });
    if (!student) throw new NotFoundException('no Student is linked to this account');
    return viewFor(student, 'self');
  }

  async get(actor: AuthUser, id: string) {
    const { student, relation } = await this.visible(actor, id);
    return viewFor(student, relation);
  }

  async update(actor: AuthUser, id: string, body: UpdateStudent) {
    const current = await this.staffRecord(actor, id);
    const next = {
      dob: body.dob ?? dateOnly(current.dob),
      payer: (body.payer ?? current.payer) as PayerKind,
      email: body.email === undefined ? current.email : body.email,
    };
    checkPayer({ ...next, hasPrimaryParent: Boolean(primaryOf(current)) });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.student.update({
        where: { id },
        data: {
          ...body,
          ...(body.dob && { dob: new Date(`${body.dob}T00:00:00Z`) }),
        },
      });
      const full = await tx.student.findUniqueOrThrow({ where: { id }, include: WITH_PARENTS });
      await this.publish(tx, 'StudentUpdated', full);
      await recordChange(tx, {
        action: 'student.update',
        entityType: 'Student',
        entityId: id,
        before: current,
        after: full,
        personal: STUDENT_PERSONAL,
      });
      return full;
    });
    return viewFor(updated, 'staff');
  }

  async addParent(actor: AuthUser, id: string, link: ParentLink) {
    const current = await this.staffRecord(actor, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (link.isPrimary) {
        await tx.studentParent.updateMany({ where: { studentId: id }, data: { isPrimary: false } });
      }
      await this.link(tx, actor, id, link);
      const full = await tx.student.findUniqueOrThrow({ where: { id }, include: WITH_PARENTS });
      await this.publish(tx, 'StudentUpdated', full);
      await recordChange(tx, {
        action: 'student.add-parent',
        entityType: 'Student',
        entityId: id,
        before: { parentLinks: links(current) },
        after: { parentLinks: links(full) },
      });
      return full;
    });
    return viewFor(updated, 'staff');
  }

  async removeParent(actor: AuthUser, id: string, parentId: string) {
    const current = await this.staffRecord(actor, id);
    const link = current.parents.find((p) => p.parentId === parentId);
    if (!link) throw new NotFoundException('this Parent is not linked to the Student');
    if (link.isPrimary) {
      throw new UnprocessableEntityException(
        'make another Parent primary before removing the primary one',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.studentParent.delete({
        where: { studentId_parentId: { studentId: id, parentId } },
      });
      await recordChange(tx, {
        action: 'student.remove-parent',
        entityType: 'Student',
        entityId: id,
        before: { parentLinks: links(current) },
        after: { parentLinks: links(current).filter((l) => l.parentId !== parentId) },
      });
    });
    return viewFor(
      await this.prisma.student.findUniqueOrThrow({ where: { id }, include: WITH_PARENTS }),
      'staff',
    );
  }

  /** class-service: `GET /internal/students/{id}` (InternalStudentResponse). */
  async internal(id: string): Promise<InternalStudentResponse> {
    const student = await this.prisma.student.findUnique({ where: { id }, include: WITH_PARENTS });
    if (!student || student.anonymisedAt) throw new NotFoundException('student not found');
    return {
      id: student.id,
      fullName: student.fullName,
      tutorId: student.tutorId,
      status: student.status,
      payerContact: payerContact(student),
    };
  }

  /**
   * Other services (Class, Schedule, Billing) ask how a user relates to a Student, so they
   * apply the same visibility rules. Admins are not resolved here: callers already know the
   * role and let Admins see everything.
   */
  async access(id: string, userId: string): Promise<InternalStudentAccessResponse> {
    const student = await this.prisma.student.findUnique({ where: { id }, include: WITH_PARENTS });
    if (!student || student.anonymisedAt) throw new NotFoundException('student not found');
    const link = student.parents.find((p) => p.parent.userId === userId);
    const relation =
      student.tutorId === userId
        ? 'tutor'
        : student.userId === userId
          ? 'self'
          : link
            ? link.isPrimary
              ? 'primary-parent'
              : 'secondary-parent'
            : null;
    const isPayer =
      (relation === 'primary-parent' && student.payer === 'PRIMARY_PARENT') ||
      (relation === 'self' && student.payer === 'SELF');
    return { studentId: id, userId, relation, isPayer };
  }

  /** Re-publishes StudentUpdated for every Student whose Payer contact may have changed. */
  async publishForParent(tx: Tx, parentId: string): Promise<void> {
    const students = await tx.student.findMany({
      where: { parents: { some: { parentId } } },
      include: WITH_PARENTS,
    });
    for (const s of students) await this.publish(tx, 'StudentUpdated', s);
  }

  // ---------------------------------------------------------------- helpers

  /** Loads a Student the caller may see, or 404 (never 403: do not reveal it exists). */
  private async visible(
    actor: AuthUser,
    id: string,
  ): Promise<{ student: StudentRecord; relation: Relation }> {
    const student = await this.prisma.student.findUnique({ where: { id }, include: WITH_PARENTS });
    if (student && !student.anonymisedAt) {
      if (actor.role === 'ADMIN' || (actor.role === 'TUTOR' && student.tutorId === actor.id)) {
        return { student, relation: 'staff' };
      }
      if (actor.role === 'STUDENT' && student.userId === actor.id)
        return { student, relation: 'self' };
      if (actor.role === 'PARENT') {
        const link = student.parents.find((p) => p.parent.userId === actor.id);
        if (link)
          return { student, relation: link.isPrimary ? 'primary-parent' : 'secondary-parent' };
      }
    }
    throw new NotFoundException('student not found');
  }

  /** The Student, if the caller is their Tutor or an Admin; 404 otherwise. */
  async staffRecord(actor: AuthUser, id: string): Promise<StudentRecord> {
    const { student, relation } = await this.visible(actor, id);
    if (relation !== 'staff') throw new NotFoundException('student not found');
    return student;
  }

  private async link(tx: Tx, actor: AuthUser, studentId: string, link: ParentLink): Promise<void> {
    let parentId: string;
    if ('parentId' in link) {
      const parent = await tx.parent.findUnique({
        where: { id: link.parentId },
        include: { students: { include: { student: { select: { tutorId: true } } } } },
      });
      const mine =
        parent &&
        (actor.role === 'ADMIN' ||
          parent.createdBy === actor.id ||
          parent.students.some((s) => s.student.tutorId === actor.id));
      if (!mine) throw new NotFoundException(`parent ${link.parentId} not found`);
      parentId = parent.id;
    } else {
      // The same Parent typed in again for a sibling: reuse the record this Tutor already has.
      const existing = link.email
        ? await tx.parent.findFirst({
            where: {
              email: { equals: link.email, mode: 'insensitive' },
              OR: [
                { createdBy: actor.id },
                { students: { some: { student: { tutorId: actor.id } } } },
              ],
            },
          })
        : null;
      parentId =
        existing?.id ??
        (
          await tx.parent.create({
            data: {
              fullName: link.fullName,
              phone: link.phone,
              email: link.email,
              createdBy: actor.id,
            },
          })
        ).id;
    }
    await tx.studentParent.upsert({
      where: { studentId_parentId: { studentId, parentId } },
      create: { studentId, parentId, isPrimary: link.isPrimary },
      update: { isPrimary: link.isPrimary },
    });
  }

  private async publish(
    tx: Tx,
    type: 'StudentCreated' | 'StudentUpdated',
    s: StudentRecord,
  ): Promise<void> {
    await enqueueEvent(tx as unknown as SqlExecutor, type, {
      studentId: s.id,
      fullName: s.fullName,
      tutorId: s.tutorId,
      payerContact: payerContact(s),
    });
  }

  /** BR-ST-04: invite the Student, or the primary Parent when the Student has no email. */
  private async sendInvitation(
    actor: AuthUser,
    student: StudentRecord,
  ): Promise<InvitationOutcome> {
    if (student.email) {
      return this.identity.invite({
        email: student.email,
        fullName: student.fullName,
        role: 'STUDENT',
        invitedBy: actor.id,
      });
    }
    const primary = primaryOf(student);
    if (primary?.email) {
      return this.identity.invite({
        email: primary.email,
        fullName: primary.fullName,
        role: 'PARENT',
        invitedBy: actor.id,
      });
    }
    return {
      status: 'skipped',
      reason: isMinor(dateOnly(student.dob))
        ? 'the primary Parent has no email'
        : 'the Student has no email',
    };
  }

  /**
   * When the Student was invited directly, the primary Parent (if they have an email)
   * is invited too, so they can follow schedule and fees with their own account.
   * Returns undefined when sendInvitation already went to the Parent or there is no one.
   */
  private async sendParentInvitation(
    actor: AuthUser,
    student: StudentRecord,
  ): Promise<InvitationOutcome | undefined> {
    const primary = primaryOf(student);
    if (!student.email || !primary?.email || primary.userId) return undefined;
    if (primary.email.toLowerCase() === student.email.toLowerCase()) return undefined;
    return this.identity.invite({
      email: primary.email,
      fullName: primary.fullName,
      role: 'PARENT',
      invitedBy: actor.id,
    });
  }
}
