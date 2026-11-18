import { z } from 'zod';

/**
 * Every id in the system is a UUID, including user ids: `userId`, `tutorId`,
 * `cancelledBy` are our own `users.id` (carried in the `userId` custom claim of
 * the Firebase ID token), never the Firebase `uid` (ADR-0004).
 */
export const Id = z.uuid();

/** Money is a whole number of VND (DECIMAL(12,0) in the databases). */
export const Money = z.number().int().nonnegative();

/** A calendar date, `YYYY-MM-DD`, in Asia/Ho_Chi_Minh (BR-SYS-02). */
export const IsoDate = z.iso.date();

/** An instant in UTC, ISO 8601 with a `Z` suffix (BR-SYS-02). */
export const IsoDateTime = z.iso.datetime();

/** A billing period, `YYYY-MM`. */
export const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

/** How to reach a person; at least one of email or phone. */
export const Contact = z
  .object({
    name: z.string().min(1).max(100),
    email: z.email().optional(),
    phone: z.string().min(6).max(20).optional(),
  })
  .refine((c) => c.email !== undefined || c.phone !== undefined, {
    message: 'contact needs an email or a phone',
  });
export type Contact = z.infer<typeof Contact>;
