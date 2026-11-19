import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { enqueueEvent } from '@tms/common';
import type { InternalCreateInvitationRequest } from '@tms/contracts';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { PrismaService } from '../prisma/prisma.service';

/** BR-AU-02: an invitation link is valid for 7 days. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface InvitationCreated {
  invitationId: string;
  userId: string;
  expiresAt: string;
  /** Only outside production: Notification (which would email it) is out of MVP scope. */
  acceptUrl?: string;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseAuthService,
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

    const firebaseUid =
      user?.firebaseUid ?? (await this.firebase.accountForInvitation(email, request.fullName));
    if (!firebaseUid)
      throw new ConflictException('this email already belongs to a registered account');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.prisma.$transaction(async (tx) => {
      user ??= await tx.user.create({
        data: { firebaseUid, email, role: request.role, status: 'PENDING' },
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
      await enqueueEvent(tx, 'InvitationCreated', {
        invitationId: created.id,
        userId: user.id,
        email,
        expiresAt: expiresAt.toISOString(),
      });
      return created;
    });

    const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/invitations/${token}`;
    const exposeLink = process.env.NODE_ENV !== 'production';
    if (exposeLink) this.logger.log(`invitation for ${email}: ${acceptUrl}`);
    return {
      invitationId: invitation.id,
      userId: invitation.userId,
      expiresAt: expiresAt.toISOString(),
      ...(exposeLink && { acceptUrl }),
    };
  }

  /**
   * Accepts an invitation once: the conditional update claims it atomically, so two
   * concurrent accepts cannot both succeed. The Firebase password and claims are set
   * inside the transaction, so a Firebase failure leaves the invitation unused.
   */
  async accept(token: string, password: string) {
    const tokenHash = hashToken(token);
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!invitation) throw new NotFoundException('unknown invitation');

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0)
        throw new GoneException('this invitation was used, revoked or has expired');

      const user = await tx.user.update({
        where: { id: invitation.userId },
        data: { status: 'ACTIVE' },
      });
      await enqueueEvent(tx, 'UserRegistered', {
        userId: user.id,
        email: user.email,
        role: user.role,
      });
      await this.firebase.activate(user.firebaseUid, password);
      await this.firebase.setClaims(user.firebaseUid, { userId: user.id, role: user.role });
      return { userId: user.id, email: user.email, role: user.role, status: user.status };
    });
  }
}
