import { z } from 'zod';
import { Id } from '@tms/contracts';

const name = z.string().trim().min(1).max(100);
const phone = z.string().trim().min(6).max(20);
const email = z.email().transform((e) => e.toLowerCase());

export const NewParent = z.object({ fullName: name, phone, email: email.optional() });

/** Either link an existing Parent or create one, and say whether they are primary. */
export const ParentLink = z.union([
  z.object({ parentId: Id, isPrimary: z.boolean() }),
  NewParent.extend({ isPrimary: z.boolean() }),
]);
export type ParentLink = z.infer<typeof ParentLink>;

export const CreateStudent = z.object({
  /** Required when an Admin creates the Student; a Tutor always creates their own. */
  tutorId: Id.optional(),
  fullName: name,
  dob: z.iso.date(),
  email: email.optional(),
  school: z.string().trim().max(150).optional(),
  grade: z.number().int().min(1).max(12).optional(),
  note: z.string().max(5000).optional(),
  /** Defaults to PRIMARY_PARENT when there is one, SELF otherwise. */
  payer: z.enum(['PRIMARY_PARENT', 'SELF']).optional(),
  parents: z.array(ParentLink).max(10).default([]),
  /** Send an Invitation (BR-ST-04). Default true. */
  invite: z.boolean().default(true),
});
export type CreateStudent = z.infer<typeof CreateStudent>;

export const UpdateStudent = z
  .object({
    fullName: name,
    dob: z.iso.date(),
    email: email.nullable(),
    school: z.string().trim().max(150).nullable(),
    grade: z.number().int().min(1).max(12).nullable(),
    note: z.string().max(5000).nullable(),
    payer: z.enum(['PRIMARY_PARENT', 'SELF']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateStudent = z.infer<typeof UpdateStudent>;

export const UpdateParent = NewParent.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'nothing to update',
});

export const ListStudents = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'GRADUATED', 'DROPPED']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
