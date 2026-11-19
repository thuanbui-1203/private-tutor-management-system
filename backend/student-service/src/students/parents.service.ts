import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@tms/common';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type { NewParent, UpdateParent } from './schemas';
import { StudentsService, viewFor } from './students.service';

@Injectable()
export class ParentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  create(actor: AuthUser, body: z.infer<typeof NewParent>) {
    return this.prisma.parent.create({ data: { ...body, createdBy: actor.id } });
  }

  /** Changing a primary Parent's contact changes the Payer contact Billing keeps (StudentUpdated). */
  async update(actor: AuthUser, id: string, body: z.infer<typeof UpdateParent>) {
    const parent = await this.prisma.parent.findUnique({
      where: { id },
      include: { students: { include: { student: { select: { tutorId: true } } } } },
    });
    const mine =
      parent &&
      (actor.role === 'ADMIN' ||
        parent.createdBy === actor.id ||
        parent.students.some((s) => s.student.tutorId === actor.id));
    if (!mine) throw new NotFoundException('parent not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.parent.update({ where: { id }, data: body });
      await this.students.publishForParent(tx, id);
      return updated;
    });
  }

  /** GET /parents/me/children: only this Parent's own children (BR-SC-10 spirit, BR-ST-06). */
  async myChildren(actor: AuthUser) {
    const links = await this.prisma.studentParent.findMany({
      where: { parent: { userId: actor.id }, student: { anonymisedAt: null } },
      include: {
        student: {
          include: { parents: { include: { parent: true }, orderBy: { isPrimary: 'desc' } } },
        },
      },
    });
    return links.map((l) =>
      viewFor(l.student, l.isPrimary ? 'primary-parent' : 'secondary-parent'),
    );
  }
}
