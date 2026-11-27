import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AttendanceStatus,
  EnrollmentStatus,
  FeeType,
  InvoiceKind,
  InvoiceStatus,
  PaymentMethod,
  Role,
  StudentStatus,
  WithdrawReason,
} from './enums';
import { Contact, Id, IsoDate, IsoDateTime, Money, Period } from './primitives';

/** Services that publish or consume events. `schedule` is Schedule & Attendance. */
export const ServiceName = z.enum([
  'identity',
  'student',
  'class',
  'schedule',
  'academic',
  'billing',
  'notification',
  'tutor',
]);
export type ServiceName = z.infer<typeof ServiceName>;

/** A Tutor profile's verification status (tutor-service, docs/07 §2). */
export const TutorProfileStatus = z.enum([
  'DRAFT',
  'SUBMITTED',
  'NEEDS_CHANGES',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
]);

interface EventDefinition<D extends z.ZodType> {
  /** `<aggregate>.<action>` on exchange `tms.events` (docs/02-cac-service.md §10). */
  routingKey: string;
  producer: ServiceName;
  consumers: readonly ServiceName[];
  data: D;
}

const define = <D extends z.ZodType>(def: EventDefinition<D>) => def;

const distinct = <T>(items: T[]) => new Set(items).size === items.length;

/**
 * Every business event, matching docs/01-nghiep-vu.md §5. A test reads that
 * table and fails if this catalog and the doc disagree.
 */
export const EVENT_CATALOG = {
  UserRegistered: define({
    routingKey: 'user.registered',
    producer: 'identity',
    consumers: ['student', 'notification'],
    data: z.object({
      userId: Id,
      email: z.email(),
      role: Role,
      /** Signed up on their own: not yet linked to records others created about this e-mail. */
      selfRegistered: z.boolean().optional(),
    }),
  }),
  InvitationCreated: define({
    routingKey: 'invitation.created',
    producer: 'identity',
    consumers: ['notification'],
    data: z.object({ invitationId: Id, userId: Id, email: z.email(), expiresAt: IsoDateTime }),
  }),
  StudentCreated: define({
    routingKey: 'student.created',
    producer: 'student',
    consumers: ['billing', 'notification'],
    data: z.object({
      studentId: Id,
      fullName: z.string().min(1).max(100),
      tutorId: Id,
      payerContact: Contact,
    }),
  }),
  StudentUpdated: define({
    routingKey: 'student.updated',
    producer: 'student',
    consumers: ['billing', 'notification'],
    data: z.object({
      studentId: Id,
      fullName: z.string().min(1).max(100),
      tutorId: Id,
      payerContact: Contact,
    }),
  }),
  StudentStatusChanged: define({
    routingKey: 'student.status-changed',
    producer: 'student',
    consumers: ['class', 'billing'],
    data: z
      .object({ studentId: Id, from: StudentStatus, to: StudentStatus })
      .refine((d) => d.from !== d.to, { message: 'from and to must differ' }),
  }),
  ClassCreated: define({
    routingKey: 'class.created',
    producer: 'class',
    consumers: ['billing', 'schedule'],
    data: z.object({
      classId: Id,
      tutorId: Id,
      feeType: FeeType,
      feeAmount: Money,
      chargeAbsent: z.boolean(),
      effectiveFrom: Period,
    }),
  }),
  ClassUpdated: define({
    routingKey: 'class.updated',
    producer: 'class',
    consumers: ['billing', 'schedule'],
    data: z.object({
      classId: Id,
      tutorId: Id,
      feeType: FeeType,
      feeAmount: Money,
      chargeAbsent: z.boolean(),
      effectiveFrom: Period,
    }),
  }),
  ClassClosed: define({
    routingKey: 'class.closed',
    producer: 'class',
    consumers: ['schedule'],
    data: z.object({ classId: Id }),
  }),
  StudentEnrolled: define({
    routingKey: 'enrollment.enrolled',
    producer: 'class',
    consumers: ['schedule', 'billing'],
    data: z
      .object({
        enrollmentId: Id,
        classId: Id,
        studentId: Id,
        studentName: z.string().min(1).max(100),
        feeType: FeeType,
        status: EnrollmentStatus.extract(['ACTIVE', 'AWAITING_PAYMENT']),
        joinedAt: IsoDate,
      })
      // BR-CL-07: Monthly-fee Classes start AWAITING_PAYMENT, Per-session Classes ACTIVE.
      .refine((d) => (d.feeType === 'MONTHLY') === (d.status === 'AWAITING_PAYMENT'), {
        message: 'MONTHLY enrollments start AWAITING_PAYMENT, PER_SESSION ones ACTIVE',
        path: ['status'],
      }),
  }),
  EnrollmentConfirmed: define({
    routingKey: 'enrollment.confirmed',
    producer: 'schedule',
    consumers: ['class', 'notification'],
    data: z.object({ enrollmentId: Id, classId: Id, studentId: Id }),
  }),
  EnrollmentSyncFailed: define({
    routingKey: 'enrollment.sync-failed',
    producer: 'schedule',
    consumers: ['class'],
    data: z.object({
      enrollmentId: Id,
      classId: Id,
      studentId: Id,
      error: z.string().min(1).max(500),
    }),
  }),
  StudentWithdrawn: define({
    routingKey: 'enrollment.withdrawn',
    producer: 'class',
    consumers: ['schedule', 'billing'],
    data: z.object({ enrollmentId: Id, classId: Id, studentId: Id, reason: WithdrawReason }),
  }),
  SessionScheduled: define({
    routingKey: 'session.scheduled',
    producer: 'schedule',
    consumers: ['billing', 'notification'],
    data: z.object({
      sessionId: Id,
      classId: Id,
      startAt: IsoDateTime,
      studentIds: z.array(Id).refine(distinct, { message: 'studentIds must be unique' }),
    }),
  }),
  SessionCancelled: define({
    routingKey: 'session.cancelled',
    producer: 'schedule',
    consumers: ['billing', 'notification'],
    data: z.object({ sessionId: Id, reason: z.string().min(1).max(500), cancelledBy: Id }),
  }),
  SessionRescheduled: define({
    routingKey: 'session.rescheduled',
    producer: 'schedule',
    consumers: ['billing', 'notification'],
    data: z
      .object({
        oldSessionId: Id,
        newSessionId: Id,
        classId: Id,
        newStartAt: IsoDateTime,
        studentIds: z.array(Id).refine(distinct, { message: 'studentIds must be unique' }),
      })
      .refine((d) => d.oldSessionId !== d.newSessionId, {
        message: 'oldSessionId and newSessionId must differ',
      }),
  }),
  AttendanceRecorded: define({
    routingKey: 'attendance.recorded',
    producer: 'schedule',
    consumers: ['billing', 'academic', 'notification'],
    data: z.object({
      sessionId: Id,
      studentId: Id,
      classId: Id,
      status: AttendanceStatus,
      date: IsoDate,
    }),
  }),
  AttendanceCorrected: define({
    routingKey: 'attendance.corrected',
    producer: 'schedule',
    consumers: ['billing'],
    data: z
      .object({
        sessionId: Id,
        studentId: Id,
        classId: Id,
        date: IsoDate,
        oldStatus: AttendanceStatus,
        newStatus: AttendanceStatus,
      })
      .refine((d) => d.oldStatus !== d.newStatus, {
        message: 'oldStatus and newStatus must differ',
      }),
  }),
  GradeRecorded: define({
    routingKey: 'grade.recorded',
    producer: 'academic',
    consumers: ['notification'],
    data: z.object({
      studentId: Id,
      classId: Id,
      type: z.enum(['HOMEWORK', 'QUIZ', 'TEST']),
      score: z.number().min(0).max(10),
    }),
  }),
  InvoiceIssued: define({
    routingKey: 'invoice.issued',
    producer: 'billing',
    consumers: ['notification'],
    data: z
      .object({
        invoiceId: Id,
        kind: InvoiceKind,
        studentId: Id,
        enrollmentId: Id.optional(),
        period: Period,
        total: Money,
        dueDate: IsoDate,
      })
      .refine((d) => (d.kind === 'ENROLLMENT') === (d.enrollmentId !== undefined), {
        message: 'enrollmentId is required for ENROLLMENT invoices and only for them',
        path: ['enrollmentId'],
      }),
  }),
  PaymentReceived: define({
    routingKey: 'payment.received',
    producer: 'billing',
    consumers: ['class', 'notification'],
    data: z
      .object({
        invoiceId: Id,
        invoiceKind: InvoiceKind,
        enrollmentId: Id.optional(),
        amount: Money.positive(),
        method: PaymentMethod,
        invoiceStatus: InvoiceStatus.extract(['PARTIALLY_PAID', 'PAID']),
      })
      .refine((d) => (d.invoiceKind === 'ENROLLMENT') === (d.enrollmentId !== undefined), {
        message: 'enrollmentId is required for ENROLLMENT invoices and only for them',
        path: ['enrollmentId'],
      }),
  }),
  InvoiceOverdue: define({
    routingKey: 'invoice.overdue',
    producer: 'billing',
    consumers: ['notification'],
    data: z.object({ invoiceId: Id, daysOverdue: z.number().int().positive() }),
  }),
  TutorStatusChanged: define({
    routingKey: 'tutor.status-changed',
    producer: 'tutor',
    // Read later by class (BR-TU-01: only VERIFIED Tutors take Students) and billing (pay).
    consumers: [],
    data: z
      .object({ tutorId: Id, from: TutorProfileStatus, to: TutorProfileStatus })
      .refine((d) => d.from !== d.to, { message: 'from and to must differ' }),
  }),
} as const;

export type EventType = keyof typeof EVENT_CATALOG;
export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export type EventData<T extends EventType> = z.infer<(typeof EVENT_CATALOG)[T]['data']>;

/** The envelope every event travels in (docs/01-nghiep-vu.md §5). */
export interface EventEnvelope<T extends EventType = EventType> {
  eventId: string;
  eventType: T;
  occurredAt: string;
  correlationId: string;
  version: 1;
  data: EventData<T>;
}

/** Any event, discriminated by `eventType`. */
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

const EnvelopeShape = z.object({
  eventId: Id,
  eventType: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  occurredAt: IsoDateTime,
  correlationId: Id,
  version: z.literal(1),
  data: z.unknown(),
});

/** Build a validated event. Throws a ZodError if `data` breaks the contract. */
export function createEvent<T extends EventType>(
  eventType: T,
  data: EventData<T>,
  meta: { correlationId: string; eventId?: string; occurredAt?: Date },
): EventEnvelope<T> {
  return parseEvent({
    eventId: meta.eventId ?? randomUUID(),
    eventType,
    occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
    correlationId: meta.correlationId,
    version: 1,
    data,
  }) as EventEnvelope<T>;
}

/** Validate an incoming message (envelope and payload). Throws a ZodError if invalid. */
export function parseEvent(raw: unknown): AnyEvent {
  const envelope = EnvelopeShape.parse(raw);
  const data = EVENT_CATALOG[envelope.eventType].data.parse(envelope.data);
  return { ...envelope, data } as AnyEvent;
}

/** Like `parseEvent`, but returns a result instead of throwing. */
export function safeParseEvent(
  raw: unknown,
): { success: true; event: AnyEvent } | { success: false; error: z.ZodError } {
  try {
    return { success: true, event: parseEvent(raw) };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error };
    throw error;
  }
}

export const routingKeyOf = (eventType: EventType): string => EVENT_CATALOG[eventType].routingKey;
