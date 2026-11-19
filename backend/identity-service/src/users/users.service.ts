import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { enqueueEvent, type AuthUser } from '@tms/common';
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

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseAuthService,
    @Inject(OPEN_CLASSES_CHECKER) private readonly openClasses: OpenClassesChecker,
  ) {}

  /**
   * Tutor self-signup (docs/02 §3). The caller already created the Firebase account
   * in the frontend. Creates the users row, publishes UserRegistered and sets the
   * `userId` + `role` claims, all-or-nothing: the claims are set last inside the
   * transaction, so a Firebase failure rolls the row and the event back.
   */
  async registerTutor(token: DecodedIdToken): Promise<UserView> {
    if (token.role !== undefined || token.userId !== undefined) {
      throw new ConflictException('this account already has a role');
    }
    if (!token.email) throw new ConflictException('the Firebase account has no email');
    const email = token.email.toLowerCase();

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { firebaseUid: token.uid, email, role: 'TUTOR', status: 'ACTIVE' },
        });
        await enqueueEvent(tx, 'UserRegistered', { userId: created.id, email, role: 'TUTOR' });
        await this.firebase.setClaims(token.uid, { userId: created.id, role: 'TUTOR' });
        return created;
      });
      return toView(user);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('this account is already registered');
      throw err;
    }
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
      if (role !== user.role) await this.firebase.setClaims(user.firebaseUid, { userId: id, role });
      if (status !== user.status)
        await this.firebase.setDisabled(user.firebaseUid, status === 'DISABLED');
      await this.firebase.revokeSessions(user.firebaseUid);
      return saved;
    });
    return toView(updated);
  }
}

export interface UserChange {
  role?: User['role'];
  status?: 'ACTIVE' | 'DISABLED';
}
