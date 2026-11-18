import { z } from 'zod';

// Shared enums that cross service boundaries. Names follow GLOSSARY.md.

export const Role = z.enum(['ADMIN', 'TUTOR', 'PARENT', 'STUDENT']);
export type Role = z.infer<typeof Role>;

export const StudentStatus = z.enum(['ACTIVE', 'PAUSED', 'GRADUATED', 'DROPPED']);
export type StudentStatus = z.infer<typeof StudentStatus>;

export const FeeType = z.enum(['PER_SESSION', 'MONTHLY']);
export type FeeType = z.infer<typeof FeeType>;

export const EnrollmentStatus = z.enum([
  'PENDING',
  'AWAITING_PAYMENT',
  'ACTIVE',
  'PAUSED',
  'WITHDRAWN',
  'REJECTED',
]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

/** Why an Enrollment became WITHDRAWN (or REJECTED, for SYNC_FAILED). */
export const WithdrawReason = z.enum([
  'REQUESTED',
  'UNPAID',
  'CLASS_CLOSED',
  'STUDENT_STATUS',
  'SYNC_FAILED',
]);
export type WithdrawReason = z.infer<typeof WithdrawReason>;

export const AttendanceStatus = z.enum(['PRESENT', 'LATE', 'EXCUSED', 'ABSENT']);
export type AttendanceStatus = z.infer<typeof AttendanceStatus>;

export const InvoiceKind = z.enum(['MONTHLY', 'ENROLLMENT']);
export type InvoiceKind = z.infer<typeof InvoiceKind>;

export const InvoiceStatus = z.enum([
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'VOID',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const PaymentMethod = z.enum(['CASH', 'BANK_TRANSFER', 'MOMO']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;
