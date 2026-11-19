/** Client-side versions of business rules, only to spare a round trip; the API decides. */
import { ageOn } from './format';

export interface ParentRow {
  fullName: string;
  phone: string;
  email: string;
  isPrimary: boolean;
}
export const emptyParent = (isPrimary: boolean): ParentRow => ({
  fullName: '',
  phone: '',
  email: '',
  isPrimary,
});

/** The checks the API would make, in Vietnamese, before sending. Empty = fine. */
export function studentFormProblems(dob: string, email: string, parents: ParentRow[]): string[] {
  const problems: string[] = [];
  const filled = parents.filter((p) => p.fullName.trim() || p.phone.trim() || p.email.trim());
  for (const p of filled) {
    if (!p.fullName.trim() || p.phone.trim().length < 6) {
      problems.push('Mỗi phụ huynh cần họ tên và số điện thoại (ít nhất 6 số).');
      break;
    }
  }
  const primaries = filled.filter((p) => p.isPrimary).length;
  if (dob && ageOn(dob) < 18 && primaries === 0) {
    problems.push('Học sinh dưới 18 tuổi phải có một phụ huynh chính (BR-ST-04).');
  }
  if (primaries > 1) problems.push('Chỉ được chọn đúng một phụ huynh chính (BR-ST-06).');
  if (dob && ageOn(dob) >= 18 && primaries === 0 && !email.trim()) {
    problems.push(
      'Học sinh đã trưởng thành tự thanh toán cần có email để nhận hóa đơn và lời mời.',
    );
  }
  return problems;
}
