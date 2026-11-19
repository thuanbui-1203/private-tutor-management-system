import type { NavItem } from '@/components/session';

/** Each role's menu. Screens are added group by group (#23). */
export const TUTOR_NAV: NavItem[] = [
  { href: '/tutor', label: 'Tổng quan' },
  { href: '/tutor/students', label: 'Học sinh' },
  { href: '/tutor/classes', label: 'Lớp học' },
  { href: '/tutor/schedule', label: 'Lịch dạy' },
  { href: '/tutor/invoices', label: 'Hóa đơn' },
  { href: '/tutor/revenue', label: 'Doanh thu' },
];
/** Admin: the Tutors list, then every Tutor screen (they see the whole centre, BR-AU-01). */
export const ADMIN_NAV: NavItem[] = [{ href: '/admin', label: 'Giáo viên' }, ...TUTOR_NAV.slice(1)];
