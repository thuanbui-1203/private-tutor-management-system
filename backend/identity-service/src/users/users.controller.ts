import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, type AuthUser } from '@tms/common';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { UsersService, type UserView } from './users.service';

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
  async register(@Headers('authorization') authorization?: string): Promise<UserView> {
    const idToken = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!idToken) throw new UnauthorizedException('missing Firebase ID token');
    const decoded = await this.firebase.verifyIdToken(idToken).catch(() => {
      throw new UnauthorizedException('invalid or revoked Firebase ID token');
    });
    return this.users.registerTutor(decoded);
  }

  @Get('users/me')
  me(@CurrentUser() user: AuthUser): Promise<UserView> {
    return this.users.findById(user.id);
  }
}
