import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Principal, Scope } from './principal.js';

export const IS_PUBLIC = 'iam:isPublic';
export const REQUIRED_SCOPES = 'iam:requiredScopes';

/** Exempts a route from authentication. Every other route requires a bearer token. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/** The scopes a route requires, all of them. A route without this is refused (default deny). */
export const RequireScopes = (...scopes: [Scope, ...Scope[]]): CustomDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

export interface AuthenticatedRequest {
  principal?: Principal;
}
