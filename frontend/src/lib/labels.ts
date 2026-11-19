/** Vietnamese labels (GLOSSARY.md terms) for the codes the API returns. */
import type {
  AttendanceStatus,
  EnrollmentStatus,
  FeeType,
  InvoiceKind,
  InvoiceStatus,
  PaymentMethod,
  Role,
  StudentStatus,
} from './types';

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Quản trị viên',
  TUTOR: 'Giáo viên',
  PARENT: 'Phụ huynh',
  STUDENT: 'Học sinh',
};

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  ACTIVE: 'Đang học',
  PAUSED: 'Tạm nghỉ',
  GRADUATED: 'Hoàn thành',
  DROPPED: 'Nghỉ học',
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  PENDING: 'Đang xử lý',
  AWAITING_PAYMENT: 'Chờ thanh toán',
  ACTIVE: 'Đang học',
  PAUSED: 'Tạm dừng',
  WITHDRAWN: 'Đã rút',
  REJECTED: 'Bị từ chối',
};

export const SESSION_STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Sắp diễn ra',
  IN_PROGRESS: 'Đang diễn ra',
  COMPLETED: 'Đã xong',
  CANCELLED: 'Đã hủy',
  RESCHEDULED: 'Đã dời',
  MISSED: 'Bị bỏ lỡ',
};

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Có mặt',
  LATE: 'Đi trễ',
  EXCUSED: 'Vắng có phép',
  ABSENT: 'Vắng không phép',
};

export const FEE_TYPE_LABEL: Record<FeeType, string> = {
  PER_SESSION: 'Theo buổi',
  MONTHLY: 'Theo tháng',
};

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  MONTHLY: 'Hóa đơn tháng',
  ENROLLMENT: 'Hóa đơn ghi danh',
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: 'Nháp',
  ISSUED: 'Đã phát hành',
  PARTIALLY_PAID: 'Trả một phần',
  PAID: 'Đã thanh toán',
  OVERDUE: 'Quá hạn',
  VOID: 'Đã hủy',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Tiền mặt',
  BANK_TRANSFER: 'Chuyển khoản',
  MOMO: 'Ví MoMo',
};

/** Where each role lands after signing in. */
export const HOME_OF: Record<Role, string> = {
  ADMIN: '/admin',
  TUTOR: '/tutor',
  PARENT: '/parent',
  STUDENT: '/student',
};
