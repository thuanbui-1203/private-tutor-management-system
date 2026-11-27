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

export type SessionStatus =
  'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'RESCHEDULED' | 'MISSED';

export interface SessionView {
  id: string;
  classId: string;
  scheduleId: string | null;
  /** Local Vietnam date and times. */
  date: string;
  startTime: string;
  endTime: string;
  /** The same instants in UTC. */
  startsAt: string;
  endsAt: string;
  status: SessionStatus;
  makeupOf: string | null;
  cancelReason: string | null;
}

export interface ScheduleView {
  id: string;
  classId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  fromDate: string;
  toDate: string | null;
  endedAt: string | null;
}

export interface Conflict {
  date: string;
  startTime: string;
  endTime: string;
  conflictsWith: { sessionId: string; classId: string; startTime: string; endTime: string };
}

export interface AttendanceSheet {
  session: SessionView;
  editableUntil: string;
  students: {
    studentId: string;
    studentName: string | null;
    status: AttendanceStatus | null;
    note: string | null;
  }[];
}

export interface AttendanceHistory {
  studentId: string;
  month: string;
  summary: Record<AttendanceStatus, number>;
  records: {
    sessionId: string;
    classId: string;
    date: string;
    startTime: string;
    endTime: string;
    status: AttendanceStatus;
    note: string | null;
  }[];
}

export interface InvoiceItemView {
  id: string;
  type: 'FEE' | 'ADJUSTMENT';
  classId: string | null;
  sessionId: string | null;
  enrollmentId: string | null;
  adjustsItemId: string | null;
  /** The month the charge is for. */
  servicePeriod: string;
  attendanceStatus: AttendanceStatus | null;
  description: string;
  amount: number;
}

export interface PaymentView {
  id: string;
  kind: 'PAYMENT' | 'REVERSAL';
  reversesPaymentId: string | null;
  amount: number;
  method: PaymentMethod;
  paidAt: string;
  note: string | null;
}

export interface InvoiceView {
  id: string;
  kind: InvoiceKind;
  studentId: string;
  enrollmentId: string | null;
  studentName: string;
  payerContact: { name?: string; email?: string; phone?: string };
  period: string;
  total: number;
  status: InvoiceStatus;
  issuedAt: string | null;
  dueDate: string | null;
  replacesInvoiceId: string | null;
  items?: InvoiceItemView[];
  payments?: PaymentView[];
  paid?: number;
  outstanding?: number;
}

export interface BalanceView {
  studentId: string;
  studentName: string;
  outstanding: number;
  overdue: number;
  currentMonthDraft: number;
  invoices: {
    invoiceId: string;
    kind: InvoiceKind;
    period: string;
    status: InvoiceStatus;
    dueDate: string | null;
    total: number;
    paid: number;
    outstanding: number;
  }[];
}

export interface RevenueReport {
  from: string;
  to: string;
  months: { period: string; billed: number; collected: number }[];
  billed: number;
  collected: number;
}

export interface QrView {
  invoiceId: string;
  amount: number;
  bankBin: string;
  accountNumber: string;
  accountName: string | null;
  description: string;
  payload: string;
}

/** billing `GET /billing/banks`: a bank that takes NAPAS 247 transfers. */
export interface BankView {
  bin: string;
  code: string;
  shortName: string;
  name: string;
}

/** billing `GET /billing/bank-account` (ADR-0006). The number is always masked. */
export interface ConsentView {
  policyVersion: string;
  grantedAt: string;
  withdrawnAt: string | null;
}
export interface OwnBankAccount {
  bankBin: string;
  accountNumberMasked: string;
  accountName: string | null;
  status: 'ACTIVE' | 'MASKED';
  maskedAt: string | null;
  consent: ConsentView;
}
export interface OwnBankAccountResponse {
  policyVersion: string;
  account: OwnBankAccount | null;
}
/** billing `GET /billing/bank-accounts`: a Payer's account, full number only while consented. */
export interface PayerBankAccount {
  ownerId: string;
  ownerRole: 'PARENT' | 'STUDENT';
  bankBin: string;
  accountNumber: string | null;
  accountNumberMasked: string;
  accountName: string | null;
  status: 'ACTIVE' | 'MASKED';
  consent: ConsentView;
}

/** audit-service (ADR-0005). */
export interface AccessRecordView {
  id: string;
  occurredAt: string;
  correlationId: string;
  userId: string | null;
  role: Role | null;
  ip: string;
  userAgent: string | null;
  method: string;
  path: string;
  queryKeys: string[];
  status: number;
  durationMs: number;
  service: string | null;
}
export interface AccessPage {
  items: AccessRecordView[];
  nextCursor: string | null;
}
export interface ChangeRecordView {
  id: string;
  occurredAt: string;
  service: string;
  correlationId: string | null;
  actorId: string | null;
  actorRole: Role | 'SYSTEM';
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, { from?: unknown; to?: unknown }>;
}
export interface ChangesResponse {
  records: ChangeRecordView[];
  unavailable: string[];
}
