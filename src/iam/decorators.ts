import {
  createParamDecorator,
  SetMetadata,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Principal, Scope } from './principal.js';

export const IS_PUBLIC = 'iam:isPublic';
export const REQUIRED_SCOPES = 'iam:requiredScopes';

/**
 * Exempts a route from authentication. The only way to do so: every other route requires a
 * valid bearer token, so a new endpoint is protected unless someone decides otherwise here.
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * The scopes a caller needs, all of them. Every authenticated route must declare this; one
 * that does not is refused, so forgetting it closes the route rather than opening it.
 */
export const RequireScopes = (...scopes: [Scope, ...Scope[]]): CustomDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

export interface AuthenticatedRequest {
  principal?: Principal;
}

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal === undefined) {
      throw new Error('CurrentPrincipal used on a route that is not authenticated.');
    }
    return principal;
  },
);
