import { z } from 'zod';

/** The secret in `.env.example`. Fine for a laptop; refused outright in production. */
export const EXAMPLE_JWT_SECRET = 'local-development-secret-change-me-0123456789';

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly port: number;
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    readonly lockTimeoutMs: number;
    readonly statementTimeoutMs: number;
    readonly transactionTimeoutMs: number;
    readonly maxWaitMs: number;
  };
  readonly auth: {
    /** HMAC key for HS256 bearer tokens. */
    readonly secret: Uint8Array;
    readonly issuer: string;
    readonly audience: string;
    readonly clockToleranceSeconds: number;
  };
  readonly fx: {
    readonly asOf: Date;
    readonly rates: Readonly<Record<string, string>>;
  };
  readonly kafka: {
    /** Off by default: the service runs, and serves HTTP, without a broker. */
    readonly enabled: boolean;
    readonly brokers: readonly string[];
    readonly clientId: string;
    readonly groupId: string;
    readonly treasuryTopic: string;
    /** Where messages that can never succeed are parked, rather than blocking the feed. */
    readonly deadLetterTopic: string;
  };
}

export const APP_CONFIG = Symbol('AppConfig');

/**
 * Rates used when `FX_RATES` is not set, outside production only, so the service runs locally
 * without extra setup. Illustrative figures, not market data.
 */
const DEVELOPMENT_FX_RATES = {
  asOf: '2026-09-19T00:00:00.000Z',
  rates: {
    'EUR/USD': '1.09',
    'GBP/USD': '1.27',
    'USD/EUR': '0.92',
    'GBP/EUR': '1.17',
    'USD/GBP': '0.79',
    'EUR/GBP': '0.85',
  },
};

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const fxTableSchema = z.object({
  asOf: z.iso.datetime({ offset: true }),
  rates: z.record(z.string(), z.string()),
});

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: integer(3000, 1, 65_535),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
    DATABASE_POOL_SIZE: integer(10, 1, 200),
    DB_LOCK_TIMEOUT_MS: integer(3_000, 50, 60_000),
    DB_STATEMENT_TIMEOUT_MS: integer(5_000, 100, 300_000),
    DB_TRANSACTION_TIMEOUT_MS: integer(10_000, 100, 300_000),
    DB_MAX_WAIT_MS: integer(5_000, 50, 60_000),

    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_CLOCK_TOLERANCE_SECONDS: integer(30, 0, 300),

    FX_RATES: z.string().optional(),

    KAFKA_ENABLED: z.enum(['true', 'false']).default('false'),
    KAFKA_BROKERS: z.string().default(''),
    KAFKA_CLIENT_ID: z.string().min(1).default('invoice-reservation'),
    KAFKA_GROUP_ID: z.string().min(1).default('invoice-reservation-capacity'),
    KAFKA_TREASURY_TOPIC: z.string().min(1).default('treasury.program-capacity'),
    KAFKA_DEAD_LETTER_TOPIC: z.string().min(1).default('treasury.program-capacity.dead-letter'),
  })
  .superRefine((env, ctx) => {
    if (env.KAFKA_ENABLED === 'true' && brokerList(env.KAFKA_BROKERS).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_BROKERS'],
        message: 'is required when KAFKA_ENABLED is true',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    if (env.JWT_SECRET === EXAMPLE_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'is the example secret from .env.example and must not be used in production',
      });
    }
    if (env.FX_RATES === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['FX_RATES'],
        message: 'is required in production; the built-in rates are for local development only',
      });
    }
  })
  .check((ctx) => {
    // The lock wait must give up before the transaction ceiling, or a waiter would time out
    // as a generic failure instead of a retryable "busy" (docs/architecture.md §6).
    const env = ctx.value;
    if (env.DB_LOCK_TIMEOUT_MS >= env.DB_TRANSACTION_TIMEOUT_MS) {
      ctx.issues.push({
        code: 'custom',
        input: env.DB_LOCK_TIMEOUT_MS,
        path: ['DB_LOCK_TIMEOUT_MS'],
        message: 'must be shorter than DB_TRANSACTION_TIMEOUT_MS',
      });
    }
  });

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads and validates configuration from the environment, reporting every problem at once
 * rather than failing on the first and making the operator fix them one restart at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }

  const values = parsed.data;

  return {
    environment: values.NODE_ENV,
    port: values.PORT,
    database: {
      url: values.DATABASE_URL,
      poolSize: values.DATABASE_POOL_SIZE,
      lockTimeoutMs: values.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: values.DB_STATEMENT_TIMEOUT_MS,
      transactionTimeoutMs: values.DB_TRANSACTION_TIMEOUT_MS,
      maxWaitMs: values.DB_MAX_WAIT_MS,
    },
    auth: {
      secret: new TextEncoder().encode(values.JWT_SECRET),
      issuer: values.JWT_ISSUER,
      audience: values.JWT_AUDIENCE,
      clockToleranceSeconds: values.JWT_CLOCK_TOLERANCE_SECONDS,
    },
    fx: parseFxTable(values.FX_RATES),
    kafka: {
      enabled: values.KAFKA_ENABLED === 'true',
      brokers: brokerList(values.KAFKA_BROKERS),
      clientId: values.KAFKA_CLIENT_ID,
      groupId: values.KAFKA_GROUP_ID,
      treasuryTopic: values.KAFKA_TREASURY_TOPIC,
      deadLetterTopic: values.KAFKA_DEAD_LETTER_TOPIC,
    },
  };
}

function brokerList(raw: string): string[] {
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

function parseFxTable(raw: string | undefined): AppConfig['fx'] {
  if (raw === undefined) {
    return { asOf: new Date(DEVELOPMENT_FX_RATES.asOf), rates: DEVELOPMENT_FX_RATES.rates };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(['FX_RATES is not valid JSON']);
  }

  const table = fxTableSchema.safeParse(json);
  if (!table.success) {
    throw new ConfigError([
      'FX_RATES must look like {"asOf":"2026-09-19T00:00:00Z","rates":{"EUR/USD":"1.09"}}',
    ]);
  }

  return { asOf: new Date(table.data.asOf), rates: table.data.rates };
}
