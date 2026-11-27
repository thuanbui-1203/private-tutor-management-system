/** Tutor profiles (tutor-service, docs/07 §2): what the API returns and Vietnamese labels. */
export type ProfileStatus =
  'DRAFT' | 'SUBMITTED' | 'NEEDS_CHANGES' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
export type TutorKind = 'STUDENT' | 'TEACHER' | 'GRADUATE';
export type CredentialKind = 'STUDENT_CARD' | 'DEGREE' | 'CERTIFICATE' | 'TRANSCRIPT';
export type ItemStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export interface SubjectView {
  id: string;
  subject: string;
  gradeFrom: number | null;
  gradeTo: number | null;
  suggestedFee: number | null;
  status: ItemStatus;
  reviewNote: string | null;
}
export interface CredentialView {
  id: string;
  kind: CredentialKind;
  title: string;
  issuer: string;
  country: string;
  number: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: ItemStatus;
  reviewNote: string | null;
  file: { name: string; mime: string; size: number } | null;
}
export type AreaView =
  | { kind: 'LOCAL'; provinceCode: number; wardCode: number | null }
  | { kind: 'ONLINE' }
  | { kind: 'ABROAD'; country: string; city: string | null; timezone: string | null };
export interface SlotView {
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
}
export interface TutorProfileView {
  tutorId: string;
  status: ProfileStatus;
  kind: TutorKind | null;
  displayName: string | null;
  bio: string | null;
  school: string | null;
  schoolCountry: string | null;
  reportedToPrincipal: boolean;
  noOwnPupils: boolean;
  gpa: number | null;
  gpaScale: number | null;
  transcriptPublic: boolean;
  submittedAt: string | null;
  verifiedAt: string | null;
  credentials: CredentialView[];
  subjects: SubjectView[];
  areas: AreaView[];
  availability: SlotView[];
  reviews?: { decision: string; reason: string | null; reviewerId: string; createdAt: string }[];
}
export interface TutorSummary {
  tutorId: string;
  displayName: string | null;
  kind: TutorKind | null;
  status: ProfileStatus;
  submittedAt: string | null;
  pendingCredentials: number;
  pendingSubjects: number;
}

export const PROFILE_STATUS: Record<ProfileStatus, [string, string]> = {
  DRAFT: ['Đang soạn', 'neutral'],
  SUBMITTED: ['Chờ duyệt', 'amber'],
  NEEDS_CHANGES: ['Cần bổ sung', 'amber'],
  VERIFIED: ['Đã xác minh', 'green'],
  REJECTED: ['Bị từ chối', 'red'],
  SUSPENDED: ['Tạm khóa', 'red'],
};
export const ITEM_STATUS: Record<ItemStatus, [string, string]> = {
  PENDING: ['Chờ duyệt', 'amber'],
  VERIFIED: ['Đã xác minh', 'green'],
  REJECTED: ['Không đạt', 'red'],
  EXPIRED: ['Hết hạn', 'neutral'],
};
export const KIND_LABEL: Record<TutorKind, string> = {
  STUDENT: 'Sinh viên',
  TEACHER: 'Giáo viên đang dạy ở trường',
  GRADUATE: 'Đã tốt nghiệp',
};
export const CREDENTIAL_LABEL: Record<CredentialKind, string> = {
  STUDENT_CARD: 'Thẻ sinh viên',
  DEGREE: 'Bằng cấp',
  CERTIFICATE: 'Chứng chỉ',
  TRANSCRIPT: 'Bảng điểm',
};
export const DECISION_LABEL: Record<string, string> = {
  VERIFY: 'Xác minh',
  NEEDS_CHANGES: 'Yêu cầu bổ sung',
  REJECT: 'Từ chối',
  SUSPEND: 'Tạm khóa',
  REINSTATE: 'Mở khóa',
};
export const gradesLabel = (s: { gradeFrom: number | null; gradeTo: number | null }) =>
  s.gradeFrom === null ? 'Không theo lớp' : `Lớp ${s.gradeFrom}–${s.gradeTo}`;
export const areaLabel = (a: AreaView) =>
  a.kind === 'ONLINE'
    ? 'Dạy online'
    : a.kind === 'LOCAL'
      ? `Tỉnh/TP mã ${a.provinceCode}${a.wardCode ? `, phường/xã mã ${a.wardCode}` : ''}`
      : `Nước ngoài: ${a.country}${a.city ? `, ${a.city}` : ''}${a.timezone ? ` (${a.timezone})` : ''}`;

/** A File as base64, without the `data:...;base64,` prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
