import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Public, Roles, type AuthUser, ZodBody } from '@tms/common';
import { Role } from '@tms/contracts';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { UsersService, type UserView } from './users.service';

/** PATCH /users/{id}: at least one of role, status. PENDING is set only by invitations. */
const UserChangeBody = z
  .object({ role: Role.optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() })
  .refine((c) => c.role !== undefined || c.status !== undefined, {
    message: 'give a role and / or a status',
  });

/** POST /auth/register. ADMIN is never chosen: it comes from ADMIN_EMAILS. */
const RegisterBody = z.object({ role: Role.extract(['TUTOR', 'PARENT', 'STUDENT']) });

const UserQuery = z.object({
  role: Role.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'DISABLED']).optional(),
});

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly firebase: FirebaseAuthService,
  ) {}

  /**
   * POST /auth/register: the gateway lets this through with a valid ID token but no
   * role yet (#8), so Identity verifies the token itself rather than relying on X-User-*.
   */
  @Public()
  @ApiBearerAuth()
  @Post('auth/register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(new ZodBody(RegisterBody)) body: z.infer<typeof RegisterBody>,
    @Headers('authorization') authorization?: string,
  ): Promise<UserView> {
    return this.users.register(await this.firebase.fromHeader(authorization), body.role);
  }

  @Get('users/me')
  me(@CurrentUser() user: AuthUser): Promise<UserView> {
    return this.users.findById(user.id);
  }

  /** Admin: users by role / status (e.g. the Tutors list), newest first. */
  @Roles('ADMIN')
  @Get('users')
  list(@Query(new ZodBody(UserQuery)) query: z.infer<typeof UserQuery>): Promise<UserView[]> {
    return this.users.list(query);
  }

  @Roles('ADMIN')
  @Get('users/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserView> {
    return this.users.findById(id);
  }

  /** Change role and / or disable / re-enable (BR-CL-08). Revokes the user's sessions. */
  @Roles('ADMIN')
  @Patch('users/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(UserChangeBody)) change: z.infer<typeof UserChangeBody>,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserView> {
    return this.users.update(actor, id, change);
  }
}
