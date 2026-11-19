import { Injectable, Logger } from '@nestjs/common';
import { InternalHttpClient } from '@tms/common';
import {
  InternalCreateInvitationResponse,
  type InternalCreateInvitationRequest,
} from '@tms/contracts';

export type InvitationOutcome =
  | { status: 'sent'; to: 'STUDENT' | 'PARENT'; email: string; invitationId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/** Calls identity-service `POST /internal/invitations` (BR-ST-04). */
@Injectable()
export class IdentityClient {
  private readonly logger = new Logger(IdentityClient.name);
  private readonly client = new InternalHttpClient(
    process.env.IDENTITY_SERVICE_URL ?? 'http://identity-service:3001',
  );

  /**
   * Never throws: a Student is still created when Identity is down; the outcome
   * tells the Tutor to re-send the invitation later.
   */
  async invite(request: InternalCreateInvitationRequest): Promise<InvitationOutcome> {
    try {
      const res = await this.client.post(
        '/internal/invitations',
        request,
        InternalCreateInvitationResponse,
      );
      return {
        status: 'sent',
        to: request.role,
        email: request.email,
        invitationId: res.invitationId,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`invitation for ${request.email} not sent: ${reason}`);
      return { status: 'failed', reason };
    }
  }
}
