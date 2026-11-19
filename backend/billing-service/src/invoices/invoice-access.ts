import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '@tms/common';
import type { Invoice } from '../generated/prisma/client';
import { StudentClient } from './student.client';

/**
 * Who may see an Invoice: Admin, the Student's Tutor, and the Payer (the primary Parent of a
 * Student paid for by their Parent, or the adult Student who pays for themselves, BR-ST-05).
 * Anyone else, a secondary Parent included, gets 404: the Invoice's existence is not revealed.
 */
@Injectable()
export class InvoiceAccess {
  constructor(private readonly students: StudentClient) {}

  async check(actor: AuthUser, invoice: Invoice | null): Promise<Invoice> {
    if (invoice && (await this.allowed(actor, invoice.studentId, invoice.tutorId))) return invoice;
    throw new NotFoundException('invoice not found');
  }

  /** May `actor` see the money of this Student? */
  async allowed(actor: AuthUser, studentId: string, tutorId: string): Promise<boolean> {
    if (actor.role === 'ADMIN') return true;
    if (actor.role === 'TUTOR') return tutorId === actor.id;
    try {
      return (await this.students.access(studentId, actor.id)).isPayer;
    } catch {
      throw new ServiceUnavailableException('student service unavailable; try again shortly');
    }
  }
}
