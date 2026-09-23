import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, REQUIRED_SCOPES, type AuthenticatedRequest } from './decorators.js';
import { canAccessProgram, type Scope } from './principal.js';
import { InvalidTokenError, TokenVerifier } from './token-verifier.js';

interface HttpRequest extends AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  method: string;
  url: string;
}

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]) ===
    true
  );
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const token = bearerToken(request.headers['authorization']);
    if (token === null) throw new UnauthorizedException('A bearer token is required.');

    try {
      request.principal = await this.tokens.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        // The reason is logged, not returned: it would help an attacker more than a client.
        throw new UnauthorizedException('The bearer token is not valid.', { cause: error });
      }
      throw error;
    }

    return true;
  }
}

/**
 * Registered globally after authentication. Default deny: the route must declare its scopes,
 * and any `:programId` in the path must be one of the caller's programs, checked here so no
 * controller can forget it.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(AuthorizationGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const principal = request.principal;
    if (principal === undefined) throw new UnauthorizedException('A bearer token is required.');

    const required = this.reflector.getAllAndOverride<Scope[] | undefined>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined) {
      this.logger.error(
        `${request.method} ${request.url} declares no required scopes and is refused; add @RequireScopes or @Public.`,
      );
      throw new ForbiddenException('This operation is not permitted.');
    }

    const missing = required.filter((scope) => !principal.scopes.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException(`This operation requires the scope ${missing.join(', ')}.`);
    }

    const programId = request.params?.['programId'];
    if (programId !== undefined && !canAccessProgram(principal, programId)) {
      throw new ForbiddenException(`The caller may not act on program ${programId}.`);
    }

    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match === null ? null : match[1];
}
