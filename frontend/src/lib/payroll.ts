/** Payroll (docs/07 §6): the shapes billing-service returns and their Vietnamese labels. */
export type PayrollRunStatus =
  'DRAFT' | 'AWAITING_FUNDS' | 'SETTLING' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';
export type PayoutStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';
export type WorkStatus =
  'NO_RATE' | 'NOT_PAYABLE' | 'WAITING_LOCK' | 'ELIGIBLE' | 'IN_RUN' | 'PAID';

export interface PayoutView {
  id: string;
  runId: string;
  tutorId: string;
  amount: number;
  status: PayoutStatus;
  attempts: number;
  bankBin: string | null;
  accountNumberMasked: string | null;
  providerRef: string | null;
  failureReason: string | null;
  paidAt: string | null;
}
export interface PayrollRunView {
  id: string;
  period: string;
  status: PayrollRunStatus;
  total: number;
  received: number;
  approvedAt: string | null;
  fundedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  payouts: PayoutView[];
}
export interface PayrollPreview {
  period: string;
  total: number;
  tutors: { tutorId: string; amount: number; sessions: number }[];
  held: {
    tutorId: string;
    amount: number;
    sessions: number;
    reason: 'NO_BANK_ACCOUNT' | 'NOTHING_TO_PAY';
  }[];
  classesWithoutRate: string[];
  canPay: boolean;
}
export interface PayRateView {
  classId: string;
  effectiveFrom: string;
  amount: number;
}
export interface WorkItemView {
  id: string;
  kind: 'WORK' | 'ADJUSTMENT';
  sessionId: string;
  classId: string;
  tutorId: string;
  date: string;
  attended: boolean;
  amount: number | null;
  status: WorkStatus;
}
export interface SandboxPaymentView {
  period: string;
  total: number;
  received: number;
}

export const RUN_STATUS: Record<PayrollRunStatus, [string, string]> = {
  DRAFT: ['Nháp', 'neutral'],
  AWAITING_FUNDS: ['Chờ thanh toán', 'amber'],
  SETTLING: ['Đang chia tiền', 'amber'],
  PARTIAL: ['Còn khoản lỗi', 'red'],
  COMPLETED: ['Đã trả đủ', 'green'],
  CANCELLED: ['Đã hủy', 'neutral'],
};
export const PAYOUT_STATUS: Record<PayoutStatus, [string, string]> = {
  PENDING: ['Chờ chuyển', 'neutral'],
  PROCESSING: ['Đang chuyển', 'amber'],
  PAID: ['Đã nhận', 'green'],
  FAILED: ['Lỗi', 'red'],
};
export const WORK_STATUS: Record<WorkStatus, [string, string]> = {
  NO_RATE: ['Chưa có mức công', 'amber'],
  NOT_PAYABLE: ['Không tính công', 'neutral'],
  WAITING_LOCK: ['Chờ hết hạn sửa điểm danh', 'neutral'],
  ELIGIBLE: ['Hợp lệ, chờ chốt', 'amber'],
  IN_RUN: ['Đang chi trả', 'amber'],
  PAID: ['Đã trả', 'green'],
};
export const HELD_REASON = {
  NO_BANK_ACCOUNT: 'Chưa có tài khoản ngân hàng (hoặc đã rút đồng ý)',
  NOTHING_TO_PAY: 'Số tiền sau điều chỉnh không dương, chuyển sang kỳ sau',
} as const;
