import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { CurrentUser, Public, Roles, type AuthUser, ZodBody } from '@tms/common';
import { InternalCreateInvitationRequest } from '@tms/contracts';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { InvitationsService } from './invitations.service';

const InviteBody = InternalCreateInvitationRequest.omit({ invitedBy: true });

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly firebase: FirebaseAuthService,
  ) {}

  /** A Tutor or Admin invites a Parent or Student; re-sending revokes the previous link. */
  @Roles('TUTOR', 'ADMIN')
  @Post('auth/invitations')
  @HttpCode(HttpStatus.CREATED)
  invite(
    @Body(new ZodBody(InviteBody)) body: z.infer<typeof InviteBody>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invitations.invite({ ...body, invitedBy: user.id });
  }

  /** Same as above for student-service when a Student is created (BR-ST-04). Blocked at the gateway. */
  @Public()
  @Post('internal/invitations')
  @HttpCode(HttpStatus.CREATED)
  inviteInternal(
    @Body(new ZodBody(InternalCreateInvitationRequest)) body: InternalCreateInvitationRequest,
  ) {
    return this.invitations.invite(body);
  }

  /**
   * The invitee, signed in with Google as the invited e-mail; the account becomes ACTIVE with
   * its userId + role claims. Identity verifies the ID token itself, as for /auth/register.
   */
  @Public()
  @Post('auth/invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  async accept(@Param('token') token: string, @Headers('authorization') authorization?: string) {
    return this.invitations.accept(token, await this.firebase.fromHeader(authorization));
  }
}
