import { z } from 'zod';
import { Role, StudentStatus } from './enums';
import { Contact, Id, IsoDateTime } from './primitives';

// Request / response bodies of the synchronous service-to-service calls.
// `/internal/**` paths are blocked at the API gateway; only services call them.

/** student-service `GET /internal/students/{id}`, called by class-service when enrolling. */
export const InternalStudentResponse = z.object({
  id: Id,
  fullName: z.string().min(1).max(100),
  tutorId: Id,
  status: StudentStatus,
  payerContact: Contact,
});
export type InternalStudentResponse = z.infer<typeof InternalStudentResponse>;

/** class-service `GET /internal/tutors/{id}/open-classes`, called by identity-service before disabling a Tutor (BR-CL-08). */
export const InternalOpenClassesResponse = z.object({
  tutorId: Id,
  classIds: z.array(Id),
});
export type InternalOpenClassesResponse = z.infer<typeof InternalOpenClassesResponse>;

/**
 * billing-service `GET /internal/students/{id}/open-invoices`, called by
 * student-service before Anonymisation (BR-ST-08). "Open" means any status
 * other than PAID or VOID, DRAFT included.
 */
export const InternalOpenInvoicesResponse = z.object({
  studentId: Id,
  invoiceIds: z.array(Id),
});
export type InternalOpenInvoicesResponse = z.infer<typeof InternalOpenInvoicesResponse>;

/**
 * identity-service `POST /internal/invitations`, called by student-service when
 * a Student is created (BR-ST-04). Creates the Firebase user, the `users` row
 * and a single-use Invitation valid for 7 days (BR-AU-02).
 */
export const InternalCreateInvitationRequest = z.object({
  email: z.email(),
  fullName: z.string().min(1).max(100),
  role: Role.extract(['PARENT', 'STUDENT']),
  invitedBy: Id,
});
export type InternalCreateInvitationRequest = z.infer<typeof InternalCreateInvitationRequest>;

export const InternalCreateInvitationResponse = z.object({
  invitationId: Id,
  userId: Id,
  expiresAt: IsoDateTime,
});
export type InternalCreateInvitationResponse = z.infer<typeof InternalCreateInvitationResponse>;

/**
 * student-service `GET /internal/students/{id}/access?userId=`: how a signed-in user
 * relates to a Student, so other services (Class, Schedule, Billing) can apply the
 * same visibility rules (BR-ST-06, BR-SC-10) without knowing who the Parents are.
 * `relation` is null when the user may not see the Student at all.
 */
export const StudentRelation = z.enum(['tutor', 'primary-parent', 'secondary-parent', 'self']);
export type StudentRelation = z.infer<typeof StudentRelation>;

export const InternalStudentAccessResponse = z.object({
  studentId: Id,
  userId: Id,
  relation: StudentRelation.nullable(),
  /**
   * Whether the user receives and settles this Student's Invoices (BR-ST-05): the primary
   * Parent of a Student paid for by their Parent, or the Student who pays for themselves.
   * Defaults to false so an older student-service never grants Payer rights by accident.
   */
  isPayer: z.boolean().default(false),
});
export type InternalStudentAccessResponse = z.infer<typeof InternalStudentAccessResponse>;

/**
 * student-service `GET /internal/tutors/{id}/payers`: the users who settle the Invoices of this
 * Tutor's Students (BR-ST-05), so billing-service shows a Tutor only their own Payers' bank
 * details (ADR-0006).
 */
export const InternalTutorPayersResponse = z.object({
  tutorId: Id,
  userIds: z.array(Id),
});
export type InternalTutorPayersResponse = z.infer<typeof InternalTutorPayersResponse>;
