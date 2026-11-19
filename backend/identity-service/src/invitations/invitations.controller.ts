import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Public, Roles, type AuthUser, ZodBody } from '@tms/common';
import { InternalCreateInvitationRequest } from '@tms/contracts';
import { InvitationsService } from './invitations.service';

const InviteBody = InternalCreateInvitationRequest.omit({ invitedBy: true });
const AcceptBody = z.object({ password: z.string().min(8).max(128) });

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

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

  /** The invitee sets a password; the account becomes ACTIVE with its userId + role claims. */
  @Public()
  @Post('auth/invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @Param('token') token: string,
    @Body(new ZodBody(AcceptBody)) body: z.infer<typeof AcceptBody>,
  ) {
    return this.invitations.accept(token, body.password);
  }
}
