import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { enqueueEvent, recordChange, type AuthUser } from '@tms/common';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OPEN_CLASSES_CHECKER, type OpenClassesChecker } from './open-classes.checker';

export type UserView = Pick<User, 'id' | 'email' | 'role' | 'status' | 'createdAt'>;

const toView = ({ id, email, role, status, createdAt }: User): UserView => ({
  id,
  email,
  role,
  status,
  createdAt,
});

/** Roles a person may choose at their first sign-in; ADMIN comes only from ADMIN_EMAILS. */
export type SelfRole = 'TUTOR' | 'PARENT' | 'STUDENT';

const adminEmails = () =>
  new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

/** The Firebase uid never leaves Identity (ADR-0004), not even in a Change record. */
const PERSONAL = ['firebaseUid'];

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseAuthService,
    @Inject(OPEN_CLASSES_CHECKER) private readonly openClasses: OpenClassesChecker,
  ) {}

  /**
   * First sign-in with Google (docs/07 §7): the person chooses a role, except that e-mails in
   * ADMIN_EMAILS become Admins; nobody can choose ADMIN. Creates the users row, publishes
   * UserRegistered and sets the `userId` + `role` claims, all-or-nothing: the claims are set
   * last inside the transaction, so a Firebase failure rolls the row and the event back.
   */
  async register(token: DecodedIdToken, chosen: SelfRole): Promise<UserView> {
    if (token.role !== undefined || token.userId !== undefined) {
      throw new ConflictException('this account already has a role');
    }
    if (!token.email) throw new ConflictException('the Google account has no email');
    const email = token.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return this.signInAgain(token.uid, existing);

    const role = adminEmails().has(email) ? 'ADMIN' : chosen;
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { firebaseUid: token.uid, email, role, status: 'ACTIVE' },
        });
        await enqueueEvent(tx, 'UserRegistered', {
          userId: created.id,
          email,
          role,
          selfRegistered: true,
        });
        await recordChange(tx, {
          action: 'user.register',
          entityType: 'User',
          entityId: created.id,
          after: created,
          personal: PERSONAL,
          actor: { id: created.id, role },
        });
        await this.firebase.setClaims(token.uid, { userId: created.id, role });
        return created;
      });
      return toView(user);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('this account is already registered');
      throw err;
    }
  }

  /**
   * The e-mail is already known. Google verified that the caller owns it, so a user whose
   * Firebase account is new (seeded, or recreated) gets their own account back, with the role
   * they already have. An invitation still has to be accepted, and a disabled user stays out.
   */
  private async signInAgain(uid: string, existing: User): Promise<UserView> {
    if (existing.status === 'PENDING') {
      throw new ConflictException({
        message: 'open the invitation link that was e-mailed to you',
        code: 'INVITED',
      });
    }
    if (existing.status === 'DISABLED') throw new ForbiddenException('this account is disabled');
    if (existing.firebaseUid === uid) {
      throw new ConflictException('this account is already registered');
    }
    const user = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.user.update({
        where: { id: existing.id },
        data: { firebaseUid: uid },
      });
      await recordChange(tx, {
        action: 'user.relink',
        entityType: 'User',
        entityId: existing.id,
        before: existing,
        after: saved,
        personal: PERSONAL,
        actor: { id: existing.id, role: existing.role },
      });
      await this.firebase.setClaims(uid, { userId: existing.id, role: existing.role });
      return saved;
    });
    return toView(user);
  }

  async list(query: { role?: User['role']; status?: User['status'] }): Promise<UserView[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.role && { role: query.role }),
        ...(query.status && { status: query.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(toView);
  }

  async findById(id: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    return toView(user);
  }

  /**
   * Admin changes a role and / or disables or re-enables a user. Every change also
   * revokes the user's Firebase sessions, so the gateway (checkRevoked) rejects
   * tokens issued before it immediately, not after the 1-hour token lifetime.
   */
  async update(actor: AuthUser, id: string, change: UserChange): Promise<UserView> {
    if (actor.id === id) throw new BadRequestException('admins cannot change their own account');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (user.status === 'PENDING' && change.status) {
      throw new ConflictException(
        'a pending invitation is activated by accepting it, not by an admin',
      );
    }

    const role = change.role ?? user.role;
    const status = change.status ?? user.status;
    if (status === 'DISABLED' && user.status !== 'DISABLED' && user.role === 'TUTOR') {
      const open = await this.openClasses.openClassIds(user.id);
      if (open.length > 0) {
        throw new ConflictException({
          message: "move this Tutor's open classes to another Tutor before disabling (BR-CL-08)",
          openClassIds: open,
        });
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.user.update({ where: { id }, data: { role, status } });
      await recordChange(tx, {
        action: 'user.update',
        entityType: 'User',
        entityId: id,
        before: user,
        after: saved,
        personal: PERSONAL,
      });
      const uid = user.firebaseUid;
      if (uid !== null) {
        if (role !== user.role) await this.firebase.setClaims(uid, { userId: id, role });
        if (status !== user.status) await this.firebase.setDisabled(uid, status === 'DISABLED');
        await this.firebase.revokeSessions(uid);
      }
      return saved;
    });
    return toView(updated);
  }
}

export interface UserChange {
  role?: User['role'];
  status?: 'ACTIVE' | 'DISABLED';
}
