/**
 * Mints a bearer token for calling the API locally, signed with the secret in `.env`.
 *
 *   npm run token                                   # every scope, every program
 *   npm run token -- --scope capacity:read --programs program-1,program-2
 *   npm run token -- --subject alice --ttl 3600
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';

if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to mint development tokens with NODE_ENV=production.');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    subject: { type: 'string', default: 'local-developer' },
    scope: {
      type: 'string',
      default: 'capacity:read reservations:write repayments:write',
    },
    programs: { type: 'string', default: '*' },
    ttl: { type: 'string', default: '3600' },
  },
});

const secret = process.env['JWT_SECRET'];
const issuer = process.env['JWT_ISSUER'];
const audience = process.env['JWT_AUDIENCE'];

if (secret === undefined || issuer === undefined || audience === undefined) {
  console.error('JWT_SECRET, JWT_ISSUER and JWT_AUDIENCE must be set; copy .env.example to .env.');
  process.exit(1);
}

const programs = values.programs === '*' ? '*' : values.programs.split(',').filter(Boolean);
const scope = values.scope.replaceAll(',', ' ');

const token = await new SignJWT({ scope, programs })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(values.subject)
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt()
  .setExpirationTime(`${Number(values.ttl)}s`)
  .sign(new TextEncoder().encode(secret));

console.log(token);
