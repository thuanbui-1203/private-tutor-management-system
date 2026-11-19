'use client';
/** Status badges with consistent colours across screens. */
import {
  ATTENDANCE_LABEL,
  ENROLLMENT_STATUS_LABEL,
  INVOICE_STATUS_LABEL,
  SESSION_STATUS_LABEL,
  STUDENT_STATUS_LABEL,
} from '@/lib/labels';
import type { AttendanceStatus, EnrollmentStatus, InvoiceStatus, StudentStatus } from '@/lib/types';
import { Badge } from './ui';

const STUDENT_TONE: Record<StudentStatus, string> = {
  ACTIVE: 'green',
  PAUSED: 'amber',
  GRADUATED: 'blue',
  DROPPED: 'red',
};
export const StudentStatusBadge = ({ status }: { status: StudentStatus }) => (
  <Badge tone={STUDENT_TONE[status]}>{STUDENT_STATUS_LABEL[status]}</Badge>
);

const ENROLLMENT_TONE: Record<EnrollmentStatus, string> = {
  PENDING: 'blue',
  AWAITING_PAYMENT: 'amber',
  ACTIVE: 'green',
  PAUSED: 'neutral',
  WITHDRAWN: 'red',
  REJECTED: 'red',
};
export const EnrollmentBadge = ({ status }: { status: EnrollmentStatus }) => (
  <Badge tone={ENROLLMENT_TONE[status]}>{ENROLLMENT_STATUS_LABEL[status]}</Badge>
);

const SESSION_TONE: Record<string, string> = {
  SCHEDULED: 'blue',
  IN_PROGRESS: 'amber',
  COMPLETED: 'green',
  CANCELLED: 'red',
  RESCHEDULED: 'neutral',
  MISSED: 'red',
};
export const SessionBadge = ({ status }: { status: string }) => (
  <Badge tone={SESSION_TONE[status]}>{SESSION_STATUS_LABEL[status] ?? status}</Badge>
);

const ATTENDANCE_TONE: Record<AttendanceStatus, string> = {
  PRESENT: 'green',
  LATE: 'amber',
  EXCUSED: 'blue',
  ABSENT: 'red',
};
export const AttendanceBadge = ({ status }: { status: AttendanceStatus }) => (
  <Badge tone={ATTENDANCE_TONE[status]}>{ATTENDANCE_LABEL[status]}</Badge>
);

const INVOICE_TONE: Record<InvoiceStatus, string> = {
  DRAFT: 'neutral',
  ISSUED: 'blue',
  PARTIALLY_PAID: 'amber',
  PAID: 'green',
  OVERDUE: 'red',
  VOID: 'neutral',
};
export const InvoiceBadge = ({ status }: { status: InvoiceStatus }) => (
  <Badge tone={INVOICE_TONE[status]}>{INVOICE_STATUS_LABEL[status]}</Badge>
);
