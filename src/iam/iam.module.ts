import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthenticationGuard, AuthorizationGuard } from './guards.js';
import { TokenVerifier } from './token-verifier.js';

/** Global guards run in registration order: authentication, then authorization. */
@Module({
  providers: [
    TokenVerifier,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class IamModule {}
