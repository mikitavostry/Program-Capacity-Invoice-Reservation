import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthenticationGuard, AuthorizationGuard } from './guards.js';
import { TokenVerifier } from './token-verifier.js';

/**
 * Global guards run in the order they are registered: authentication first, so authorization
 * always has a principal to reason about.
 */
@Module({
  providers: [
    TokenVerifier,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class IamModule {}
