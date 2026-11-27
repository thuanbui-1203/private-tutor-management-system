import { z } from 'zod';

const country = z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 country code, e.g. VN');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const timezone = z
  .string()
  .max(50)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'an IANA time zone, e.g. Asia/Ho_Chi_Minh');
const date = z.iso.date();
const grade = z.number().int().min(1).max(12);

export const SubjectInput = z
  .object({
    subject: z.string().trim().min(1).max(50),
    gradeFrom: grade.nullable().default(null),
    gradeTo: grade.nullable().default(null),
    suggestedFee: z.number().int().positive().max(100_000_000).nullable().default(null),
  })
  .refine((s) => (s.gradeFrom === null) === (s.gradeTo === null), {
    message: 'give both gradeFrom and gradeTo, or neither',
  })
  .refine((s) => s.gradeFrom === null || s.gradeFrom <= s.gradeTo!, {
    message: 'gradeFrom must not be after gradeTo',
  });

export const AreaInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LOCAL'),
    provinceCode: z.number().int().positive(),
    /** Null = anywhere in the province. */
    wardCode: z.number().int().positive().nullable().default(null),
  }),
  z.object({ kind: z.literal('ONLINE') }),
  z.object({
    kind: z.literal('ABROAD'),
    country,
    city: z.string().trim().max(100).nullable().default(null),
    timezone: timezone.nullable().default(null),
  }),
]);

export const SlotInput = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startTime: time,
    endTime: time,
    timezone: timezone.default('Asia/Ho_Chi_Minh'),
  })
  .refine((s) => s.startTime < s.endTime, { message: 'startTime must be before endTime' });

/** PUT /tutors/me: the whole profile; lists replace what was there. */
export const ProfileInput = z
  .object({
    kind: z.enum(['STUDENT', 'TEACHER', 'GRADUATE']).nullable().default(null),
    displayName: z.string().trim().min(1).max(100).nullable().default(null),
    bio: z.string().trim().max(2000).nullable().default(null),
    school: z.string().trim().min(1).max(200).nullable().default(null),
    schoolCountry: country.nullable().default(null),
    reportedToPrincipal: z.boolean().default(false),
    noOwnPupils: z.boolean().default(false),
    gpa: z.number().min(0).max(100).nullable().default(null),
    gpaScale: z.number().positive().max(100).nullable().default(null),
    transcriptPublic: z.boolean().default(false),
    subjects: z.array(SubjectInput).max(30).default([]),
    areas: z.array(AreaInput).max(30).default([]),
    availability: z.array(SlotInput).max(50).default([]),
  })
  .refine((p) => p.gpa === null || (p.gpaScale !== null && p.gpa <= p.gpaScale), {
    message: 'gpa needs a gpaScale it does not exceed',
    path: ['gpa'],
  });
export type ProfileInput = z.infer<typeof ProfileInput>;

export const CredentialInput = z
  .object({
    kind: z.enum(['STUDENT_CARD', 'DEGREE', 'CERTIFICATE', 'TRANSCRIPT']),
    title: z.string().trim().min(1).max(200),
    issuer: z.string().trim().min(1).max(200),
    country,
    number: z.string().trim().max(100).nullable().default(null),
    issuedOn: date.nullable().default(null),
    expiresOn: date.nullable().default(null),
    /** PDF, PNG or JPEG, at most 5 MB, base64. Never a photo of an ID card (BR-TU-02). */
    file: z.object({
      name: z.string().trim().min(1).max(200),
      contentBase64: z.string().min(1).max(7_100_000),
    }),
  })
  .refine((c) => !c.issuedOn || !c.expiresOn || c.issuedOn < c.expiresOn, {
    message: 'expiresOn must be after issuedOn',
    path: ['expiresOn'],
  });
export type CredentialInput = z.infer<typeof CredentialInput>;

const itemDecision = z.object({
  id: z.uuid(),
  status: z.enum(['VERIFIED', 'REJECTED']),
  note: z.string().trim().max(500).nullable().default(null),
});

export const ReviewInput = z.object({
  decision: z.enum(['VERIFY', 'NEEDS_CHANGES', 'REJECT', 'SUSPEND', 'REINSTATE']),
  reason: z.string().trim().max(1000).nullable().default(null),
  credentials: z.array(itemDecision).max(50).default([]),
  subjects: z.array(itemDecision).max(50).default([]),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const ListQuery = z.object({
  status: z
    .enum(['DRAFT', 'SUBMITTED', 'NEEDS_CHANGES', 'VERIFIED', 'REJECTED', 'SUSPENDED'])
    .optional(),
  /** Profiles waiting for an Admin: SUBMITTED, or VERIFIED with new items to check. */
  waiting: z.enum(['true', 'false']).optional(),
});
