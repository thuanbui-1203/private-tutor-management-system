import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { enqueueEvent, recordChange } from '@tms/common';
import type { InternalCreateInvitationRequest } from '@tms/contracts';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationMailer } from './invitation-mailer';

/** BR-AU-02: an invitation link is valid for 7 days. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface InvitationCreated {
  invitationId: string;
  userId: string;
  expiresAt: string;
  /** Only outside production, for local testing without an inbox. */
  acceptUrl?: string;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseAuthService,
    private readonly mailer: InvitationMailer,
  ) {}

  /**
   * Invites a Parent or Student, or re-sends to someone still PENDING: either way a
   * fresh single-use token is issued and any earlier unused one is revoked (BR-AU-02).
   */
  async invite(request: InternalCreateInvitationRequest): Promise<InvitationCreated> {
    const email = request.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.status !== 'PENDING') {
      throw new ConflictException('this person already has an active account');
    }
    if (user && user.role !== request.role) {
      throw new ConflictException(`already invited as ${user.role}`);
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.prisma.$transaction(async (tx) => {
      user ??= await tx.user.create({
        data: { email, role: request.role, status: 'PENDING' },
      });
      await tx.invitation.updateMany({
        where: { userId: user.id, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await tx.invitation.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          invitedBy: request.invitedBy,
          expiresAt,
        },
      });
      // Actor: the Tutor / Admin on POST /auth/invitations; SYSTEM when student-service
      // asks (its own Change record for the Student carries the same correlation id).
      await recordChange(tx, {
        action: 'invitation.create',
        entityType: 'Invitation',
        entityId: created.id,
        after: created,
      });
      await enqueueEvent(tx, 'InvitationCreated', {
        invitationId: created.id,
        userId: user.id,
        email,
        expiresAt: expiresAt.toISOString(),
      });
      return created;
    });

    // The frontend's activation page is /invite/[token].
    const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/invite/${token}`;
    const exposeLink = process.env.NODE_ENV !== 'production';
    if (exposeLink) this.logger.log(`invitation for ${email}: ${acceptUrl}`);
    await this.mailer.send({
      to: email,
      fullName: request.fullName,
      role: request.role,
      acceptUrl,
      expiresAt,
    });
    return {
      invitationId: invitation.id,
      userId: invitation.userId,
      expiresAt: expiresAt.toISOString(),
      ...(exposeLink && { acceptUrl }),
    };
  }

  /**
   * Accepts an invitation once, signed in with Google as the invited e-mail: a forwarded link
   * is useless to anyone else. The conditional update claims it atomically, so two concurrent
   * accepts cannot both succeed. The claims are set inside the transaction, so a Firebase
   * failure leaves the invitation unused.
   */
  async accept(token: string, google: DecodedIdToken) {
    const tokenHash = hashToken(token);
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!invitation) throw new NotFoundException('unknown invitation');
    if (google.email?.toLowerCase() !== invitation.user.email) {
      throw new ForbiddenException('this invitation is for another e-mail address');
    }
    if (google.role !== undefined || google.userId !== undefined) {
      // A used link: say so, rather than "already has a role".
      throw invitation.usedAt
        ? new GoneException('this invitation was used, revoked or has expired')
        : new ConflictException('this account already has a role');
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0)
        throw new GoneException('this invitation was used, revoked or has expired');

      const user = await tx.user.update({
        where: { id: invitation.userId },
        data: { status: 'ACTIVE', firebaseUid: google.uid },
      });
      await recordChange(tx, {
        action: 'invitation.accept',
        entityType: 'User',
        entityId: user.id,
        before: invitation.user,
        after: user,
        personal: ['firebaseUid'],
        actor: { id: user.id, role: user.role },
      });
      await enqueueEvent(tx, 'UserRegistered', {
        userId: user.id,
        email: user.email,
        role: user.role,
      });
      await this.firebase.setClaims(google.uid, { userId: user.id, role: user.role });
      return { userId: user.id, email: user.email, role: user.role, status: user.status };
    });
  }
}
