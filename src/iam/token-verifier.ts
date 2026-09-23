import { Inject, Injectable } from '@nestjs/common';
import { errors, jwtVerify, type JWTPayload } from 'jose';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.js';
import type { Principal } from './principal.js';

export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid bearer token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies HS256 bearer tokens (signature, expiry, issuer, audience; algorithm pinned). With a
 * real identity provider this would verify against its JWKS instead, a change confined here.
 */
@Injectable()
export class TokenVerifier {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(token: string): Promise<Principal> {
    const { secret, issuer, audience, clockToleranceSeconds } = this.config.auth;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer,
        audience,
        clockTolerance: clockToleranceSeconds,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (error) {
      throw new InvalidTokenError(describe(error));
    }

    return {
      subject: payload.sub as string,
      scopes: new Set(parseScopes(payload['scope'])),
      programs: parsePrograms(payload['programs']),
    };
  }
}

function parseScopes(claim: unknown): string[] {
  if (claim === undefined) return [];
  if (typeof claim !== 'string') throw new InvalidTokenError('the scope claim must be a string');
  return claim.split(' ').filter((scope) => scope.length > 0);
}

/** No `programs` claim means no programs; all of them must be granted explicitly with `"*"`. */
function parsePrograms(claim: unknown): '*' | ReadonlySet<string> {
  if (claim === undefined) return new Set();
  if (claim === '*') return '*';
  if (Array.isArray(claim) && claim.every((id) => typeof id === 'string')) {
    return new Set(claim as string[]);
  }
  throw new InvalidTokenError('the programs claim must be "*" or an array of program ids');
}

function describe(error: unknown): string {
  if (error instanceof errors.JWTExpired) return 'it has expired';
  if (error instanceof errors.JWTClaimValidationFailed)
    return `its ${error.claim} claim is not accepted`;
  if (error instanceof errors.JWSSignatureVerificationFailed)
    return 'its signature does not verify';
  if (error instanceof errors.JOSEAlgNotAllowed) return 'it uses an algorithm that is not accepted';
  return 'it is malformed';
}
