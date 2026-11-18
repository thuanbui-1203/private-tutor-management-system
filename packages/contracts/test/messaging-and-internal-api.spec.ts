import {
  deadLetterQueueName,
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  InternalCreateInvitationRequest,
  InternalCreateInvitationResponse,
  InternalOpenClassesResponse,
  InternalOpenInvoicesResponse,
  InternalStudentResponse,
  queueName,
} from '../src';
import { ids } from './fixtures';

describe('RabbitMQ naming (docs/02-cac-service.md §10)', () => {
  it('uses the documented exchanges', () => {
    expect(EVENTS_EXCHANGE).toBe('tms.events');
    expect(DEAD_LETTER_EXCHANGE).toBe('tms.dlx');
  });

  it('names queues <service>.<event> in kebab case', () => {
    expect(queueName('billing', 'AttendanceRecorded')).toBe('billing.attendance-recorded');
    expect(queueName('class', 'EnrollmentSyncFailed')).toBe('class.enrollment-sync-failed');
    expect(deadLetterQueueName('billing')).toBe('billing.dlq');
  });
});

describe('internal API DTOs', () => {
  const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

  it('student lookup', () => {
    roundTrip(InternalStudentResponse, {
      id: ids.student,
      fullName: 'Trần Minh An',
      tutorId: ids.tutor,
      status: 'ACTIVE',
      payerContact: { name: 'Nguyễn Thị Lan', email: 'lan@example.com' },
    });
    expect(
      InternalStudentResponse.safeParse({ id: ids.student, fullName: 'An', tutorId: ids.tutor })
        .success,
    ).toBe(false);
  });

  it('open classes of a Tutor', () => {
    roundTrip(InternalOpenClassesResponse, { tutorId: ids.tutor, classIds: [ids.class] });
    expect(InternalOpenClassesResponse.safeParse({ tutorId: ids.tutor }).success).toBe(false);
  });

  it('open invoices of a Student', () => {
    roundTrip(InternalOpenInvoicesResponse, { studentId: ids.student, invoiceIds: [] });
    expect(
      InternalOpenInvoicesResponse.safeParse({ studentId: 'not-a-uuid', invoiceIds: [] }).success,
    ).toBe(false);
  });

  it('invitation creation only invites Parents and Students', () => {
    roundTrip(InternalCreateInvitationRequest, {
      email: 'parent@example.com',
      fullName: 'Nguyễn Thị Lan',
      role: 'PARENT',
      invitedBy: ids.tutor,
    });
    expect(
      InternalCreateInvitationRequest.safeParse({
        email: 'x@example.com',
        fullName: 'X',
        role: 'ADMIN',
        invitedBy: ids.tutor,
      }).success,
    ).toBe(false);
    roundTrip(InternalCreateInvitationResponse, {
      invitationId: ids.invitation,
      userId: ids.user,
      expiresAt: '2026-11-25T03:00:00Z',
    });
  });
});
