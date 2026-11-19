import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  currentPeriod,
  enqueueEvent,
  nextPeriod,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import type { InternalOpenClassesResponse } from '@tms/contracts';
import { z } from 'zod';
import type { Class, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;

/** Enrollment statuses that hold a seat (BR-CL-06). */
export const SEAT_HOLDING = ['PENDING', 'AWAITING_PAYMENT', 'ACTIVE'] as const;
/** Enrollment statuses a Class closure withdraws (BR-CL-05). */
const LIVE = ['PENDING', 'AWAITING_PAYMENT', 'ACTIVE', 'PAUSED'] as const;

const fee = {
  feeType: z.enum(['PER_SESSION', 'MONTHLY']),
  feeAmount: z.number().int().positive(),
  chargeAbsent: z.boolean(),
};

export const CreateClass = z
  .object({
    /** Admin only: create for another Tutor. Defaults to the caller (BR-AU-01). */
    tutorId: z.uuid().optional(),
    name: z.string().trim().min(1).max(100),
    subject: z.string().trim().min(1).max(50),
    type: z.enum(['ONE_ON_ONE', 'GROUP']),
    /** GROUP only, 2–8 (docs/01 §1); ONE_ON_ONE is always 1 (BR-CL-01). */
    maxStudents: z.number().int().min(2).max(8).optional(),
    feeType: fee.feeType,
    feeAmount: fee.feeAmount,
    chargeAbsent: fee.chargeAbsent.default(true),
  })
  .refine((c) => (c.type === 'GROUP') === (c.maxStudents !== undefined), {
    message: 'a GROUP class needs maxStudents (2–8); a ONE_ON_ONE class has exactly one seat',
    path: ['maxStudents'],
  });
export type CreateClass = z.infer<typeof CreateClass>;

export const UpdateClass = z
  .object({
    name: z.string().trim().min(1).max(100),
    subject: z.string().trim().min(1).max(50),
    maxStudents: z.number().int().min(2).max(8),
    ...fee,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateClass = z.infer<typeof UpdateClass>;

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actor: AuthUser, body: CreateClass): Promise<Class> {
    const tutorId = actor.role === 'ADMIN' ? (body.tutorId ?? actor.id) : actor.id;
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.class.create({
        data: {
          tutorId,
          name: body.name,
          subject: body.subject,
          type: body.type,
          maxStudents: body.type === 'ONE_ON_ONE' ? 1 : body.maxStudents!,
          feeType: body.feeType,
          feeAmount: body.feeAmount,
          chargeAbsent: body.chargeAbsent,
          feeEffectiveFrom: currentPeriod(),
        },
      });
      await this.publishFee(tx, 'ClassCreated', created);
      return created;
    });
  }

  list(actor: AuthUser, status?: 'OPEN' | 'CLOSED') {
    return this.prisma.class.findMany({
      where: { ...(actor.role !== 'ADMIN' && { tutorId: actor.id }), ...(status && { status }) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The Class, if the caller owns it or is an Admin; 404 otherwise (never reveal others'). */
  async owned(actor: AuthUser, id: string): Promise<Class> {
    const found = await this.prisma.class.findUnique({ where: { id } });
    if (!found || (actor.role !== 'ADMIN' && found.tutorId !== actor.id)) {
      throw new NotFoundException('class not found');
    }
    return found;
  }

  /**
   * A fee change applies from the next billing period and never touches issued
   * Invoices (BR-CL-04): ClassUpdated carries effectiveFrom = next period.
   */
  async update(actor: AuthUser, id: string, body: UpdateClass): Promise<Class> {
    const current = await this.owned(actor, id);
    if (current.status === 'CLOSED')
      throw new ConflictException('a closed class cannot be changed');
    if (body.maxStudents !== undefined) {
      if (current.type === 'ONE_ON_ONE') {
        throw new UnprocessableEntityException('a ONE_ON_ONE class always has one seat');
      }
      const taken = await this.prisma.enrollment.count({
        where: { classId: id, status: { in: [...SEAT_HOLDING] } },
      });
      if (body.maxStudents < taken) {
        throw new ConflictException(`${taken} seats are taken; maxStudents cannot go below that`);
      }
    }
    const feeChanged =
      (body.feeType !== undefined && body.feeType !== current.feeType) ||
      (body.feeAmount !== undefined && body.feeAmount !== current.feeAmount) ||
      (body.chargeAbsent !== undefined && body.chargeAbsent !== current.chargeAbsent);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.class.update({
        where: { id },
        data: { ...body, ...(feeChanged && { feeEffectiveFrom: nextPeriod(currentPeriod()) }) },
      });
      if (feeChanged) await this.publishFee(tx, 'ClassUpdated', updated);
      return updated;
    });
  }

  /** BR-CL-05: every live Enrollment is withdrawn (StudentWithdrawn each), then ClassClosed. */
  async close(actor: AuthUser, id: string): Promise<Class> {
    const current = await this.owned(actor, id);
    if (current.status === 'CLOSED') throw new ConflictException('the class is already closed');
    return this.prisma.$transaction(async (tx) => {
      const live = await tx.enrollment.findMany({
        where: { classId: id, status: { in: [...LIVE] } },
      });
      for (const e of live) {
        await tx.enrollment.update({
          where: { id: e.id },
          data: { status: 'WITHDRAWN', withdrawReason: 'CLASS_CLOSED', leftAt: new Date() },
        });
        await enqueueEvent(exec(tx), 'StudentWithdrawn', {
          enrollmentId: e.id,
          classId: id,
          studentId: e.studentId,
          reason: 'CLASS_CLOSED',
        });
      }
      const closed = await tx.class.update({ where: { id }, data: { status: 'CLOSED' } });
      await enqueueEvent(exec(tx), 'ClassClosed', { classId: id });
      return closed;
    });
  }

  /** GET /classes/{id}/students: who currently holds a seat or is paused. */
  async students(actor: AuthUser, id: string) {
    await this.owned(actor, id);
    return this.prisma.enrollment.findMany({
      where: { classId: id, status: { in: [...LIVE] } },
      orderBy: { studentName: 'asc' },
      select: {
        id: true,
        studentId: true,
        studentName: true,
        status: true,
        paymentDeadline: true,
        joinedAt: true,
      },
    });
  }

  /** identity-service, before disabling a Tutor (BR-CL-08). */
  async openClasses(tutorId: string): Promise<InternalOpenClassesResponse> {
    const open = await this.prisma.class.findMany({
      where: { tutorId, status: 'OPEN' },
      select: { id: true },
    });
    return { tutorId, classIds: open.map((c) => c.id) };
  }

  private publishFee(tx: Tx, type: 'ClassCreated' | 'ClassUpdated', c: Class) {
    return enqueueEvent(exec(tx), type, {
      classId: c.id,
      tutorId: c.tutorId,
      feeType: c.feeType,
      feeAmount: c.feeAmount,
      chargeAbsent: c.chargeAbsent,
      effectiveFrom: c.feeEffectiveFrom,
    });
  }
}
