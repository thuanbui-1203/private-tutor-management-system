import type { NavItem } from '@/components/session';

/** Each role's menu. Screens are added group by group (#23). */
export const TUTOR_NAV: NavItem[] = [
  { href: '/tutor', label: 'Tổng quan' },
  { href: '/tutor/profile', label: 'Hồ sơ' },
  { href: '/tutor/students', label: 'Học sinh' },
  { href: '/tutor/classes', label: 'Lớp học' },
  { href: '/tutor/schedule', label: 'Lịch dạy' },
  { href: '/tutor/invoices', label: 'Hóa đơn' },
  { href: '/tutor/revenue', label: 'Doanh thu' },
  { href: '/tutor/payer-accounts', label: 'TK phụ huynh' },
  { href: '/tutor/pay', label: 'Công dạy' },
  { href: '/tutor/bank-account', label: 'TK nhận tiền' },
];
/** Admin: the Tutors list, then every Tutor screen (they see the whole centre, BR-AU-01). */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Giáo viên' },
  { href: '/admin/tutors', label: 'Duyệt gia sư' },
  { href: '/admin/payroll', label: 'Trả công' },
  { href: '/admin/audit', label: 'Nhật ký' },
  ...TUTOR_NAV.slice(1),
];
