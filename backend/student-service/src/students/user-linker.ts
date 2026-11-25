import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Messaging, type SqlExecutor } from '@tms/common';
import type { EventEnvelope } from '@tms/contracts';

/**
 * Consumes UserRegistered: when an invited Student or Parent activates their account,
 * link Identity's users.id to the matching record by email, so X-User-Id finds them.
 */
@Injectable()
export class UserLinker implements OnModuleInit {
  constructor(private readonly messaging: Messaging) {}

  onModuleInit(): Promise<void> {
    return this.messaging.subscribe('UserRegistered', (event, tx) => this.link(event, tx));
  }

  async link(event: EventEnvelope<'UserRegistered'>, tx: SqlExecutor): Promise<void> {
    const { userId, email, role, selfRegistered } = event.data;
    // Only accepting an invitation agrees to the link. Otherwise any Tutor could attach someone
    // to a Student (and to what that gives access to) just by typing in their e-mail.
    if (selfRegistered) return;
    const table = role === 'STUDENT' ? 'students' : role === 'PARENT' ? 'parents' : undefined;
    if (!table) return; // Tutors and Admins have no record here
    await tx.$executeRawUnsafe(
      `UPDATE ${table} SET user_id = $1::uuid, updated_at = now()
        WHERE lower(email) = lower($2) AND user_id IS NULL`,
      userId,
      email,
    );
  }
}
