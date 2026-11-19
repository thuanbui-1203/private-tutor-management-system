/**
 * Shapes of the gateway's public responses that the screens use. Status enums come from
 * `@tms/contracts`, so a renamed value there breaks the frontend build.
 */
import type {
  AttendanceStatus,
  EnrollmentStatus,
  FeeType,
  InvoiceKind,
  InvoiceStatus,
  PaymentMethod,
  Role,
  StudentStatus,
} from '@tms/contracts';

export type {
  AttendanceStatus,
  EnrollmentStatus,
  FeeType,
  InvoiceKind,
  InvoiceStatus,
  PaymentMethod,
  Role,
  StudentStatus,
};

export interface UserView {
  id: string;
  email: string;
  role: Role | null;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface ParentView {
  id: string;
  fullName: string;
  isPrimary: boolean;
  phone?: string;
  email?: string | null;
}

export interface StudentView {
  id: string;
  tutorId: string;
  fullName: string;
  email: string | null;
  dob: string;
  school: string | null;
  grade: number | null;
  status: StudentStatus;
  /** Tutor / Admin only (BR-ST-07). */
  note?: string | null;
  /** Only for those who may see billing. */
  payer?: 'PRIMARY_PARENT' | 'SELF';
  payerContact?: { name: string; email?: string; phone?: string };
  parents: ParentView[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InvitationOutcome {
  status: 'sent' | 'skipped' | 'failed';
  to?: Role;
  email?: string;
  reason?: string;
}

export interface ClassView {
  id: string;
  tutorId: string;
  name: string;
  subject: string;
  type: 'ONE_ON_ONE' | 'GROUP';
  maxStudents: number;
  feeType: FeeType;
  feeAmount: number;
  chargeAbsent: boolean;
  /** YYYY-MM: the period the current fee applies from (BR-CL-04). */
  feeEffectiveFrom: string;
  status: 'OPEN' | 'CLOSED';
}

export interface EnrollmentView {
  id: string;
  studentId: string;
  studentName: string;
  status: EnrollmentStatus;
  paymentDeadline: string | null;
  joinedAt: string;
}

export interface StudentClassView {
  enrollmentId: string;
  status: EnrollmentStatus;
  joinedAt: string;
  paymentDeadline: string | null;
  class: Pick<ClassView, 'id' | 'name' | 'subject' | 'type' | 'feeType' | 'tutorId'>;
}
