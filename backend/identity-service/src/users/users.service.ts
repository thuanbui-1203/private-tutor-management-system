import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { enqueueEvent } from '@tms/common';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

  async findById(id: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    return toView(user);
  }
}
