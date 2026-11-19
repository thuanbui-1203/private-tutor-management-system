import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Id, Role } from '@tms/contracts';

/** The signed-in user, as forwarded by the API gateway (ADR-0004). */
export interface AuthUser {
  /** Identity's users.id (UUID), from the `userId` custom claim. */
  id: string;
  role: Role;
}

const ROLES_KEY = 'tms:roles';
const PUBLIC_KEY = 'tms:public';

/** Restricts a route or controller to these roles. Without it, any signed-in role passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Skips authentication: health, metrics, docs, and `/internal/**` service-to-service calls. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Injects the AuthUser into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user,
);

/**
 * Global guard for every business service. The gateway verifies the Firebase ID
 * token, strips client-supplied X-User-* headers and sets its own, so services
 * trust these headers. Missing or malformed → 401; role not allowed → 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const id = Id.safeParse(req.header('x-user-id'));
    const role = Role.safeParse(req.header('x-user-role'));
    if (!id.success || !role.success) {
      throw new UnauthorizedException('missing or invalid X-User-Id / X-User-Role');
    }
    req.user = { id: id.data, role: role.data };

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (allowed && !allowed.includes(role.data)) {
      throw new ForbiddenException(`role ${role.data} may not access this resource`);
    }
    return true;
  }
}
