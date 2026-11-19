import type { NavItem } from '@/components/session';

/** Each role's menu. Screens are added group by group (#23). */
export const TUTOR_NAV: NavItem[] = [{ href: '/tutor', label: 'Tổng quan' }];
export const PARENT_NAV: NavItem[] = [{ href: '/parent', label: 'Tổng quan' }];
export const STUDENT_NAV: NavItem[] = [{ href: '/student', label: 'Tổng quan' }];
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Tổng quan' },
  { href: '/tutor', label: 'Màn hình giáo viên' },
];
