import type { EventData, EventType } from '../src';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ids = {
  user: id(1),
  tutor: id(2),
  student: id(3),
  class: id(4),
  enrollment: id(5),
  session: id(6),
  session2: id(7),
  invoice: id(8),
  invitation: id(9),
  correlation: id(10),
};

const payer = { name: 'Nguyễn Thị Lan', email: 'lan@example.com', phone: '0901234567' };

/** One valid payload per event. Typed so that a new event without a fixture fails to compile. */
export const validData: { [K in EventType]: EventData<K> } = {
  UserRegistered: { userId: ids.user, email: 'tutor@tms.local', role: 'TUTOR' },
  InvitationCreated: {
    invitationId: ids.invitation,
    userId: ids.user,
    email: 'parent@example.com',
    expiresAt: '2026-11-25T03:00:00Z',
  },
  StudentCreated: {
    studentId: ids.student,
    fullName: 'Trần Minh An',
    tutorId: ids.tutor,
    payerContact: payer,
  },
  StudentUpdated: {
    studentId: ids.student,
    fullName: 'Trần Minh An',
    tutorId: ids.tutor,
    payerContact: { name: 'Trần Minh An', phone: '0912345678' },
  },
  StudentStatusChanged: { studentId: ids.student, from: 'ACTIVE', to: 'PAUSED' },
  ClassCreated: {
    classId: ids.class,
    tutorId: ids.tutor,
    feeType: 'PER_SESSION',
    feeAmount: 200000,
    chargeAbsent: true,
    effectiveFrom: '2026-11',
  },
  ClassUpdated: {
    classId: ids.class,
    tutorId: ids.tutor,
    feeType: 'MONTHLY',
    feeAmount: 1500000,
    chargeAbsent: false,
    effectiveFrom: '2026-12',
  },
  ClassClosed: { classId: ids.class },
  StudentEnrolled: {
    enrollmentId: ids.enrollment,
    classId: ids.class,
    studentId: ids.student,
    studentName: 'Trần Minh An',
    feeType: 'MONTHLY',
    status: 'AWAITING_PAYMENT',
    joinedAt: '2026-11-18',
  },
  EnrollmentConfirmed: { enrollmentId: ids.enrollment, classId: ids.class, studentId: ids.student },
  EnrollmentSyncFailed: {
    enrollmentId: ids.enrollment,
    classId: ids.class,
    studentId: ids.student,
    error: 'roster update failed',
  },
  StudentWithdrawn: {
    enrollmentId: ids.enrollment,
    classId: ids.class,
    studentId: ids.student,
    reason: 'UNPAID',
  },
  SessionScheduled: {
    sessionId: ids.session,
    classId: ids.class,
    startAt: '2026-11-19T12:00:00Z',
    studentIds: [ids.student],
  },
  SessionCancelled: { sessionId: ids.session, reason: 'Giáo viên ốm', cancelledBy: ids.tutor },
  SessionRescheduled: {
    oldSessionId: ids.session,
    newSessionId: ids.session2,
    classId: ids.class,
    newStartAt: '2026-11-20T12:00:00Z',
    studentIds: [ids.student],
  },
  AttendanceRecorded: {
    sessionId: ids.session,
    studentId: ids.student,
    classId: ids.class,
    status: 'PRESENT',
    date: '2026-11-19',
  },
  AttendanceCorrected: {
    sessionId: ids.session,
    studentId: ids.student,
    classId: ids.class,
    date: '2026-11-19',
    oldStatus: 'ABSENT',
    newStatus: 'EXCUSED',
  },
  GradeRecorded: { studentId: ids.student, classId: ids.class, type: 'QUIZ', score: 8.5 },
  InvoiceIssued: {
    invoiceId: ids.invoice,
    kind: 'ENROLLMENT',
    studentId: ids.student,
    enrollmentId: ids.enrollment,
    period: '2026-11',
    total: 750000,
    dueDate: '2026-11-25',
  },
  PaymentReceived: {
    invoiceId: ids.invoice,
    invoiceKind: 'MONTHLY',
    amount: 500000,
    method: 'BANK_TRANSFER',
    invoiceStatus: 'PARTIALLY_PAID',
  },
  InvoiceOverdue: { invoiceId: ids.invoice, daysOverdue: 5 },
};

/** One payload per event that breaks its contract, with the reason. */
export const invalidData: { [K in EventType]: { reason: string; data: unknown } } = {
  UserRegistered: {
    reason: 'unknown role',
    data: { ...validData.UserRegistered, role: 'OWNER' },
  },
  InvitationCreated: {
    reason: 'expiresAt is not an ISO datetime',
    data: { ...validData.InvitationCreated, expiresAt: '25/11/2026' },
  },
  StudentCreated: {
    reason: 'payer contact has neither email nor phone',
    data: { ...validData.StudentCreated, payerContact: { name: 'Lan' } },
  },
  StudentUpdated: {
    reason: 'tutorId is not a UUID (e.g. a Firebase uid)',
    data: { ...validData.StudentUpdated, tutorId: 'Xk2a9FbQ1sR7firebaseUid' },
  },
  StudentStatusChanged: {
    reason: 'from equals to',
    data: { ...validData.StudentStatusChanged, to: 'ACTIVE' },
  },
  ClassCreated: {
    reason: 'fee is not a whole number of VND',
    data: { ...validData.ClassCreated, feeAmount: 199999.5 },
  },
  ClassUpdated: {
    reason: 'chargeAbsent missing',
    data: { ...validData.ClassUpdated, chargeAbsent: undefined },
  },
  ClassClosed: { reason: 'classId missing', data: {} },
  StudentEnrolled: {
    reason: 'MONTHLY enrollment published as ACTIVE (BR-CL-07)',
    data: { ...validData.StudentEnrolled, status: 'ACTIVE' },
  },
  EnrollmentConfirmed: {
    reason: 'enrollmentId missing',
    data: { classId: ids.class, studentId: ids.student },
  },
  EnrollmentSyncFailed: {
    reason: 'empty error',
    data: { ...validData.EnrollmentSyncFailed, error: '' },
  },
  StudentWithdrawn: {
    reason: 'unknown withdraw reason',
    data: { ...validData.StudentWithdrawn, reason: 'EXPELLED' },
  },
  SessionScheduled: {
    reason: 'duplicate student ids',
    data: { ...validData.SessionScheduled, studentIds: [ids.student, ids.student] },
  },
  SessionCancelled: {
    reason: 'empty reason',
    data: { ...validData.SessionCancelled, reason: '' },
  },
  SessionRescheduled: {
    reason: 'old and new session are the same',
    data: { ...validData.SessionRescheduled, newSessionId: ids.session },
  },
  AttendanceRecorded: {
    reason: 'unknown attendance status',
    data: { ...validData.AttendanceRecorded, status: 'SICK' },
  },
  AttendanceCorrected: {
    reason: 'old and new status are the same',
    data: { ...validData.AttendanceCorrected, newStatus: 'ABSENT' },
  },
  GradeRecorded: {
    reason: 'score above 10',
    data: { ...validData.GradeRecorded, score: 11 },
  },
  InvoiceIssued: {
    reason: 'ENROLLMENT invoice without enrollmentId',
    data: { ...validData.InvoiceIssued, enrollmentId: undefined },
  },
  PaymentReceived: {
    reason: 'zero amount',
    data: { ...validData.PaymentReceived, amount: 0 },
  },
  InvoiceOverdue: {
    reason: 'daysOverdue is zero',
    data: { ...validData.InvoiceOverdue, daysOverdue: 0 },
  },
};
