import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import type { App } from 'supertest/types.js';
import { setupApiDocs } from '../../src/api-docs.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/platform/config/app-config.js';
import { APP_OPTIONS, configureApp } from '../../src/platform/http/configure-app.js';
import { testDatabaseUrl } from '../infrastructure/database.js';

export const E2E_AUTH = {
  secret: 'end-to-end-test-secret-long-enough-0123456789',
  issuer: 'e2e-issuer',
  audience: 'e2e-audience',
} as const;

export interface TestApp {
  readonly app: INestApplication<App>;
  close(): Promise<void>;
}

/** The real application, configured the way `main.ts` configures it, over the test database. */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    JWT_SECRET: E2E_AUTH.secret,
    JWT_ISSUER: E2E_AUTH.issuer,
    JWT_AUDIENCE: E2E_AUTH.audience,
    ...env,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  }).compile();

  const app = configureApp(moduleRef.createNestApplication({ ...APP_OPTIONS, logger: false }));
  setupApiDocs(app);
  await app.init();

  return {
    app: app as INestApplication<App>,
    close: () => app.close(),
  };
}

export interface TokenOptions {
  readonly subject?: string;
  readonly scope?: string;
  /** `'*'`, a list of program ids, or `null` to leave the claim out entirely. */
  readonly programs?: '*' | string[] | null;
  readonly issuer?: string;
  readonly audience?: string;
  readonly secret?: string;
  /** Seconds since the epoch. Defaults to an hour from now. */
  readonly expiresAt?: number;
}

export const ALL_SCOPES = 'capacity:read reservations:write repayments:write';

export async function token(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { scope: options.scope ?? ALL_SCOPES };
  if (options.programs !== null) claims['programs'] = options.programs ?? '*';

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.subject ?? 'e2e-client')
    .setIssuer(options.issuer ?? E2E_AUTH.issuer)
    .setAudience(options.audience ?? E2E_AUTH.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(options.secret ?? E2E_AUTH.secret));
}

/**
 * A token that claims every scope but is not signed at all — `alg: none`. Verifiers that let
 * the token choose its algorithm have accepted exactly this.
 */
export function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: 'attacker',
    iss: E2E_AUTH.issuer,
    aud: E2E_AUTH.audience,
    exp: now + 3600,
    scope: ALL_SCOPES,
    programs: '*',
  })}.`;
}
