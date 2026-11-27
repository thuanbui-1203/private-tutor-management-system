import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  enqueueEvent,
  recordChange,
  todayInVietnam,
  type AuthUser,
  type SqlExecutor,
} from '@tms/common';
import type { Prisma, ProfileStatus } from '../generated/prisma/client';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CredentialInput, ProfileInput, ReviewInput } from './schemas';

type Tx = Prisma.TransactionClient;
const exec = (tx: Tx) => tx as unknown as SqlExecutor;

/** Personal fields of a profile or credential on top of @tms/common's PERSONAL_FIELDS. */
const PERSONAL = ['number', 'school', 'gpa', 'bio'];
/** Fields that say who the Tutor is: changing them on a VERIFIED profile needs a new review. */
const IDENTITY = ['kind', 'displayName', 'school', 'schoolCountry'] as const;

const FULL = {
  credentials: { include: { file: true }, orderBy: { createdAt: 'asc' } },
  subjects: { orderBy: { createdAt: 'asc' } },
  areas: true,
  availability: { orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] },
  reviews: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.TutorProfileInclude;
type Full = Prisma.TutorProfileGetPayload<{ include: typeof FULL }>;

const day = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);
const dateOnly = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

/** BR-TU-06: an expired credential is no longer counted as verified. */
const credentialStatus = (c: { status: string; expiresOn: Date | null }, today: string) =>
  c.status === 'VERIFIED' && c.expiresOn && dateOnly(c.expiresOn)! < today ? 'EXPIRED' : c.status;

/** The profile as its owner and Admins see it (`reviews` only for Admins). */
export function view(p: Full, admin: boolean) {
  const today = todayInVietnam();
  return {
    tutorId: p.tutorId,
    status: p.status,
    kind: p.kind,
    displayName: p.displayName,
    bio: p.bio,
    school: p.school,
    schoolCountry: p.schoolCountry,
    reportedToPrincipal: p.reportedToPrincipal,
    noOwnPupils: p.noOwnPupils,
    gpa: p.gpa === null ? null : Number(p.gpa),
    gpaScale: p.gpaScale === null ? null : Number(p.gpaScale),
    transcriptPublic: p.transcriptPublic,
    submittedAt: p.submittedAt?.toISOString() ?? null,
    verifiedAt: p.verifiedAt?.toISOString() ?? null,
    credentials: p.credentials.map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      issuer: c.issuer,
      country: c.country,
      number: c.number,
      issuedOn: dateOnly(c.issuedOn),
      expiresOn: dateOnly(c.expiresOn),
      status: credentialStatus(c, today),
      reviewNote: c.reviewNote,
      file: c.file && { name: c.file.name, mime: c.file.mime, size: c.file.size },
    })),
    subjects: p.subjects.map((s) => ({
      id: s.id,
      subject: s.subject,
      gradeFrom: s.gradeFrom,
      gradeTo: s.gradeTo,
      suggestedFee: s.suggestedFee,
      status: s.status,
      reviewNote: s.reviewNote,
    })),
    areas: p.areas.map(({ kind, provinceCode, wardCode, country, city, timezone }) => ({
      kind,
      provinceCode,
      wardCode,
      country,
      city,
      timezone,
    })),
    availability: p.availability.map(({ weekday, startTime, endTime, timezone }) => ({
      weekday,
      startTime,
      endTime,
      timezone,
    })),
    ...(admin && {
      reviews: p.reviews.map((r) => ({
        decision: r.decision,
        reason: r.reason,
        reviewerId: r.reviewerId,
        createdAt: r.createdAt.toISOString(),
      })),
    }),
  };
}

const subjectKey = (s: { subject: string; gradeFrom: number | null; gradeTo: number | null }) =>
  `${s.subject.toLowerCase()}|${s.gradeFrom}|${s.gradeTo}`;

/** Tutor profiles and their verification by an Admin (docs/07 §2). */
@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  private load(db: Tx | PrismaService, tutorId: string): Promise<Full | null> {
    return db.tutorProfile.findUnique({ where: { tutorId }, include: FULL });
  }

  /** The caller's profile, created as a DRAFT at the first visit. */
  async mine(actor: AuthUser): Promise<Full> {
    await this.prisma.tutorProfile.upsert({
      where: { tutorId: actor.id },
      create: { tutorId: actor.id },
      update: {},
    });
    return (await this.load(this.prisma, actor.id))!;
  }

  /** Locks the profile row for this transaction and checks it may be edited now. */
  private async editable(tx: Tx, tutorId: string): Promise<Full> {
    await tx.$executeRawUnsafe(
      'SELECT 1 FROM tutor_profiles WHERE tutor_id = $1::uuid FOR UPDATE',
      tutorId,
    );
    const p = await this.load(tx, tutorId);
    if (!p) throw new NotFoundException('open your profile first');
    if (p.status === 'SUBMITTED') {
      throw new ConflictException('the profile is being reviewed; wait for the decision');
    }
    if (p.status === 'REJECTED' || p.status === 'SUSPENDED') {
      throw new ConflictException(`a ${p.status} profile cannot be changed`);
    }
    return p;
  }

  /**
   * PUT /tutors/me. Subjects already reviewed keep their status; new ones wait for review.
   * Changing who the Tutor is (kind, name, school) on a VERIFIED profile sends it back for review.
   */
  async save(actor: AuthUser, input: ProfileInput): Promise<Full> {
    const { subjects, areas, availability, ...fields } = input;
    const keys = new Set<string>();
    for (const s of subjects) {
      if (keys.has(subjectKey(s)))
        throw new UnprocessableEntityException(`${s.subject} is listed twice`);
      keys.add(subjectKey(s));
    }
    await this.mine(actor);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.editable(tx, actor.id);
      const reidentified =
        before.status === 'VERIFIED' && IDENTITY.some((k) => (before[k] ?? null) !== fields[k]);
      const existing = new Map(before.subjects.map((s) => [subjectKey(s), s]));
      await tx.tutorSubject.deleteMany({
        where: {
          tutorId: actor.id,
          id: { notIn: subjects.flatMap((s) => existing.get(subjectKey(s))?.id ?? []) },
        },
      });
      for (const s of subjects) {
        const kept = existing.get(subjectKey(s));
        if (kept) {
          await tx.tutorSubject.update({
            where: { id: kept.id },
            data: { suggestedFee: s.suggestedFee },
          });
        } else {
          await tx.tutorSubject.create({ data: { ...s, tutorId: actor.id } });
        }
      }
      await tx.serviceArea.deleteMany({ where: { tutorId: actor.id } });
      await tx.serviceArea.createMany({ data: areas.map((a) => ({ ...a, tutorId: actor.id })) });
      await tx.availability.deleteMany({ where: { tutorId: actor.id } });
      await tx.availability.createMany({
        data: availability.map((a) => ({ ...a, tutorId: actor.id })),
      });
      await tx.tutorProfile.update({
        where: { tutorId: actor.id },
        data: {
          ...fields,
          ...(reidentified && { status: 'SUBMITTED', submittedAt: new Date() }),
        },
      });
      if (reidentified) await this.statusChanged(tx, actor.id, 'VERIFIED', 'SUBMITTED');
      const after = (await this.load(tx, actor.id))!;
      await recordChange(exec(tx), {
        action: 'tutor-profile.save',
        entityType: 'TutorProfile',
        entityId: actor.id,
        before: view(before, false),
        after: view(after, false),
        personal: PERSONAL,
      });
      return after;
    });
  }

  /** POST /tutors/me/credentials: the file is stored first, then the credential that points to it. */
  async addCredential(actor: AuthUser, input: CredentialInput): Promise<Full> {
    await this.mine(actor);
    await this.prisma.$transaction((tx) => this.editable(tx, actor.id)); // fail before uploading
    const file = await this.files.upload(actor.id, input.file);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.editable(tx, actor.id);
        const { issuedOn, expiresOn, kind, title, issuer, country, number } = input;
        const rest = { kind, title, issuer, country, number };
        const created = await tx.credential.create({
          data: {
            ...rest,
            tutorId: actor.id,
            issuedOn: day(issuedOn),
            expiresOn: day(expiresOn),
            fileId: file.id,
          },
        });
        await recordChange(exec(tx), {
          action: 'credential.add',
          entityType: 'Credential',
          entityId: created.id,
          after: { ...created, fileSha256: file.sha256 },
          personal: PERSONAL,
        });
        return (await this.load(tx, actor.id))!;
      });
    } catch (err) {
      await this.files.remove(file.id);
      throw err;
    }
  }

  async removeCredential(actor: AuthUser, id: string): Promise<Full> {
    const profile = await this.prisma.$transaction(async (tx) => {
      await this.editable(tx, actor.id);
      const c = await tx.credential.findFirst({ where: { id, tutorId: actor.id } });
      if (!c) throw new NotFoundException('credential not found');
      await tx.credential.delete({ where: { id } });
      await recordChange(exec(tx), {
        action: 'credential.remove',
        entityType: 'Credential',
        entityId: id,
        before: c,
        personal: PERSONAL,
      });
      return { fileId: c.fileId };
    });
    if (profile.fileId) await this.files.remove(profile.fileId);
    return (await this.load(this.prisma, actor.id))!;
  }

  /** The file of a credential, for its owner or an Admin; 404 to anyone else. */
  async credentialFile(actor: AuthUser, tutorId: string, id: string) {
    if (actor.role !== 'ADMIN' && actor.id !== tutorId)
      throw new NotFoundException('file not found');
    const c = await this.prisma.credential.findFirst({ where: { id, tutorId } });
    if (!c?.fileId) throw new NotFoundException('file not found');
    return this.files.content(c.fileId);
  }

  /** POST /tutors/me/submit: everything needed for a decision is there (BR-TU-03). */
  async submit(actor: AuthUser): Promise<Full> {
    await this.mine(actor);
    return this.prisma.$transaction(async (tx) => {
      const p = await this.editable(tx, actor.id);
      const missing: string[] = [];
      if (!p.kind) missing.push('kind');
      if (!p.displayName) missing.push('displayName');
      if (!p.school) missing.push('school');
      if (p.subjects.length === 0) missing.push('subjects');
      if (p.areas.length === 0) missing.push('areas');
      if (p.credentials.length === 0) missing.push('credentials');
      if (p.kind === 'STUDENT' && !p.credentials.some((c) => c.kind === 'STUDENT_CARD'))
        missing.push('a STUDENT_CARD credential');
      if (p.kind === 'TEACHER' && !(p.reportedToPrincipal && p.noOwnPupils))
        missing.push('reportedToPrincipal and noOwnPupils (BR-TU-03)');
      if (missing.length) {
        throw new UnprocessableEntityException({ message: 'the profile is not complete', missing });
      }
      const pending =
        p.credentials.some((c) => c.status === 'PENDING') ||
        p.subjects.some((s) => s.status === 'PENDING');
      if (p.status === 'VERIFIED') {
        // Already verified: only the new items need a look; the profile stays visible.
        if (!pending) throw new ConflictException('nothing new to review');
        await tx.tutorProfile.update({
          where: { tutorId: actor.id },
          data: { submittedAt: new Date() },
        });
      } else {
        await tx.tutorProfile.update({
          where: { tutorId: actor.id },
          data: { status: 'SUBMITTED', submittedAt: new Date() },
        });
        await this.statusChanged(tx, actor.id, p.status, 'SUBMITTED');
      }
      await recordChange(exec(tx), {
        action: 'tutor-profile.submit',
        entityType: 'TutorProfile',
        entityId: actor.id,
        before: { status: p.status },
        after: { status: p.status === 'VERIFIED' ? 'VERIFIED' : 'SUBMITTED' },
      });
      return (await this.load(tx, actor.id))!;
    });
  }

  // ---------------------------------------------------------------- Admin

  async list(q: { status?: ProfileStatus; waiting?: 'true' | 'false' }) {
    const rows = await this.prisma.tutorProfile.findMany({
      where: {
        ...(q.status && { status: q.status }),
        ...(q.waiting === 'true' && {
          OR: [
            { status: 'SUBMITTED' },
            {
              status: 'VERIFIED',
              submittedAt: { not: null },
              OR: [
                { credentials: { some: { status: 'PENDING' } } },
                { subjects: { some: { status: 'PENDING' } } },
              ],
            },
          ],
        }),
      },
      include: {
        _count: {
          select: {
            credentials: { where: { status: 'PENDING' } },
            subjects: { where: { status: 'PENDING' } },
          },
        },
      },
      orderBy: [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: 200,
    });
    return rows.map((r) => ({
      tutorId: r.tutorId,
      displayName: r.displayName,
      kind: r.kind,
      status: r.status,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      pendingCredentials: r._count.credentials,
      pendingSubjects: r._count.subjects,
    }));
  }

  async get(tutorId: string): Promise<Full> {
    const p = await this.load(this.prisma, tutorId);
    if (!p) throw new NotFoundException('tutor profile not found');
    return p;
  }

  /** POST /tutors/{id}/review: item decisions, then the decision on the profile. */
  async review(actor: AuthUser, tutorId: string, input: ReviewInput): Promise<Full> {
    if (actor.id === tutorId) throw new ForbiddenException('nobody reviews their own profile');
    const needsReason = ['NEEDS_CHANGES', 'REJECT', 'SUSPEND'].includes(input.decision);
    if (needsReason && !input.reason) {
      throw new UnprocessableEntityException('give the Tutor a reason for this decision');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT 1 FROM tutor_profiles WHERE tutor_id = $1::uuid FOR UPDATE',
        tutorId,
      );
      const p = await this.load(tx, tutorId);
      if (!p) throw new NotFoundException('tutor profile not found');
      const allowed: Record<string, ProfileStatus[]> = {
        VERIFY: ['SUBMITTED', 'VERIFIED'],
        NEEDS_CHANGES: ['SUBMITTED', 'VERIFIED'],
        REJECT: ['SUBMITTED'],
        SUSPEND: ['VERIFIED'],
        REINSTATE: ['SUSPENDED'],
      };
      if (!allowed[input.decision].includes(p.status)) {
        throw new ConflictException(`cannot ${input.decision} a ${p.status} profile`);
      }

      const owned = (ids: { id: string }[], list: { id: string }[], what: string) => {
        const known = new Set(list.map((x) => x.id));
        const stranger = ids.find((d) => !known.has(d.id));
        if (stranger)
          throw new UnprocessableEntityException(`${what} ${stranger.id} is not on this profile`);
      };
      owned(input.credentials, p.credentials, 'credential');
      owned(input.subjects, p.subjects, 'subject');
      for (const d of input.credentials) {
        await tx.credential.update({
          where: { id: d.id },
          data: { status: d.status, reviewNote: d.note },
        });
      }
      for (const d of input.subjects) {
        await tx.tutorSubject.update({
          where: { id: d.id },
          data: { status: d.status, reviewNote: d.note },
        });
      }
      const after = (await this.load(tx, tutorId))!;
      const today = todayInVietnam();

      if (input.decision === 'VERIFY') {
        const undecided = [
          ...after.credentials
            .filter((c) => c.status === 'PENDING')
            .map((c) => `credential ${c.title}`),
          ...after.subjects
            .filter((s) => s.status === 'PENDING')
            .map((s) => `subject ${s.subject}`),
        ];
        if (undecided.length) {
          throw new UnprocessableEntityException({
            message: 'decide every new item first',
            undecided,
          });
        }
        if (!after.credentials.some((c) => credentialStatus(c, today) === 'VERIFIED')) {
          throw new UnprocessableEntityException('verify at least one valid credential');
        }
        if (!after.subjects.some((s) => s.status === 'VERIFIED')) {
          throw new UnprocessableEntityException('verify at least one subject');
        }
      }
      const next: ProfileStatus = {
        VERIFY: 'VERIFIED',
        NEEDS_CHANGES: 'NEEDS_CHANGES',
        REJECT: 'REJECTED',
        SUSPEND: 'SUSPENDED',
        REINSTATE: 'VERIFIED',
      }[input.decision] as ProfileStatus;

      await tx.tutorProfile.update({
        where: { tutorId },
        data: {
          status: next,
          ...(input.decision === 'VERIFY' && { verifiedAt: new Date(), submittedAt: null }),
        },
      });
      await tx.review.create({
        data: { tutorId, reviewerId: actor.id, decision: input.decision, reason: input.reason },
      });
      if (next !== p.status) await this.statusChanged(tx, tutorId, p.status, next);
      await recordChange(exec(tx), {
        action: 'tutor-profile.review',
        entityType: 'TutorProfile',
        entityId: tutorId,
        before: { status: p.status },
        after: {
          status: next,
          decision: input.decision,
          credentials: input.credentials.map(({ id, status }) => ({ id, status })),
          subjects: input.subjects.map(({ id, status }) => ({ id, status })),
        },
      });
      return (await this.load(tx, tutorId))!;
    });
  }

  private statusChanged(tx: Tx, tutorId: string, from: ProfileStatus, to: ProfileStatus) {
    return enqueueEvent(exec(tx), 'TutorStatusChanged', { tutorId, from, to });
  }
}
