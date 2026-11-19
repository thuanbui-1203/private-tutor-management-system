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
