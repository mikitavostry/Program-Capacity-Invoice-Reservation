import { z } from 'zod';

/** The secret in `.env.example`; refused in production. */
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
    /** Off by default, so the HTTP API runs without a broker. */
    readonly enabled: boolean;
    readonly brokers: readonly string[];
    /** Verified against `caLocation` when given, else the system CAs. */
    readonly ssl: { readonly enabled: boolean; readonly caLocation: string | undefined };
    /** Required in production. */
    readonly sasl: KafkaSasl | undefined;
    readonly clientId: string;
    readonly groupId: string;
    readonly treasuryTopic: string;
    readonly deadLetterTopic: string;
    readonly capacityEventsTopic: string;
    readonly outboxPollIntervalMs: number;
  };
}

export interface KafkaSasl {
  readonly mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  readonly username: string;
  readonly password: string;
}

export const APP_CONFIG = Symbol('AppConfig');

/** Illustrative rates used outside production when `FX_RATES` is not set. */
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
    KAFKA_SSL: z.enum(['true', 'false']).default('false'),
    KAFKA_SSL_CA_LOCATION: z.string().min(1).optional(),
    KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
    KAFKA_SASL_USERNAME: z.string().min(1).optional(),
    KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
    KAFKA_CLIENT_ID: z.string().min(1).default('invoice-reservation'),
    KAFKA_GROUP_ID: z.string().min(1).default('invoice-reservation-capacity'),
    KAFKA_TREASURY_TOPIC: z.string().min(1).default('treasury.program-capacity'),
    KAFKA_DEAD_LETTER_TOPIC: z.string().min(1).default('treasury.program-capacity.dead-letter'),
    KAFKA_CAPACITY_EVENTS_TOPIC: z.string().min(1).default('capacity.events'),
    OUTBOX_POLL_INTERVAL_MS: integer(500, 50, 60_000),
  })
  .superRefine((env, ctx) => {
    if (env.KAFKA_ENABLED === 'true' && brokerList(env.KAFKA_BROKERS).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_BROKERS'],
        message: 'is required when KAFKA_ENABLED is true',
      });
    }
    if (env.KAFKA_SASL_MECHANISM !== undefined) {
      for (const key of ['KAFKA_SASL_USERNAME', 'KAFKA_SASL_PASSWORD'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required with KAFKA_SASL_MECHANISM',
          });
        }
      }
    }

    if (env.NODE_ENV !== 'production') return;

    // Anyone who can write to the treasury topic can change credit limits.
    if (env.KAFKA_ENABLED === 'true' && env.KAFKA_SSL !== 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_SSL'],
        message: 'must be true in production; the brokers are not reached in plaintext',
      });
    }
    if (env.KAFKA_ENABLED === 'true' && env.KAFKA_SASL_MECHANISM === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_SASL_MECHANISM'],
        message: 'is required in production; the service authenticates to the brokers',
      });
    }

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
    // Otherwise a lock waiter fails as a generic timeout instead of a retryable CAPACITY_BUSY.
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
      ssl: { enabled: values.KAFKA_SSL === 'true', caLocation: values.KAFKA_SSL_CA_LOCATION },
      sasl:
        values.KAFKA_SASL_MECHANISM === undefined
          ? undefined
          : {
              mechanism: values.KAFKA_SASL_MECHANISM,
              // Guaranteed present with a mechanism by the refinement above.
              username: values.KAFKA_SASL_USERNAME ?? '',
              password: values.KAFKA_SASL_PASSWORD ?? '',
            },
      clientId: values.KAFKA_CLIENT_ID,
      groupId: values.KAFKA_GROUP_ID,
      treasuryTopic: values.KAFKA_TREASURY_TOPIC,
      deadLetterTopic: values.KAFKA_DEAD_LETTER_TOPIC,
      capacityEventsTopic: values.KAFKA_CAPACITY_EVENTS_TOPIC,
      outboxPollIntervalMs: values.OUTBOX_POLL_INTERVAL_MS,
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
