import { describe, expect, it } from 'vitest';
import { ConfigError, EXAMPLE_JWT_SECRET, loadConfig } from '../app-config.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5433/capacity',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-0123456789',
  JWT_ISSUER: 'issuer',
  JWT_AUDIENCE: 'audience',
};

function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('loadConfig', () => {
  it('applies defaults for everything optional', () => {
    const config = loadConfig(valid);

    expect(config.environment).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.database.poolSize).toBe(10);
    expect(config.database.lockTimeoutMs).toBe(3000);
    expect(config.fx.rates['EUR/USD']).toBe('1.09');
  });

  it('reads numbers from their string form', () => {
    expect(loadConfig({ ...valid, PORT: '8080', DATABASE_POOL_SIZE: '25' })).toMatchObject({
      port: 8080,
      database: { poolSize: 25 },
    });
  });

  it('reports every problem at once, not just the first', () => {
    const found = problems({ PORT: 'eighty', JWT_SECRET: 'short' });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^PORT/),
        expect.stringMatching(/^DATABASE_URL/),
        expect.stringMatching(/^JWT_SECRET must be at least 32 characters/),
        expect.stringMatching(/^JWT_ISSUER/),
        expect.stringMatching(/^JWT_AUDIENCE/),
      ]),
    );
  });

  it('insists on a postgres URL', () => {
    expect(problems({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toEqual([
      expect.stringMatching(/^DATABASE_URL must be a postgresql:\/\/ URL/),
    ]);
  });

  it('requires the lock wait to give up before the transaction does', () => {
    expect(
      problems({ ...valid, DB_LOCK_TIMEOUT_MS: '10000', DB_TRANSACTION_TIMEOUT_MS: '10000' }),
    ).toEqual([expect.stringMatching(/DB_LOCK_TIMEOUT_MS must be shorter/)]);
  });

  describe('Kafka security', () => {
    const kafka = { ...valid, KAFKA_ENABLED: 'true', KAFKA_BROKERS: 'broker:9093' };

    it('connects in plaintext without credentials unless told otherwise', () => {
      expect(loadConfig(kafka).kafka).toMatchObject({
        ssl: { enabled: false, caLocation: undefined },
        sasl: undefined,
      });
    });

    it('reads TLS and SASL settings', () => {
      const config = loadConfig({
        ...kafka,
        KAFKA_SSL: 'true',
        KAFKA_SSL_CA_LOCATION: '/etc/ssl/kafka-ca.pem',
        KAFKA_SASL_MECHANISM: 'scram-sha-512',
        KAFKA_SASL_USERNAME: 'capacity',
        KAFKA_SASL_PASSWORD: 'secret',
      });

      expect(config.kafka.ssl).toEqual({ enabled: true, caLocation: '/etc/ssl/kafka-ca.pem' });
      expect(config.kafka.sasl).toEqual({
        mechanism: 'scram-sha-512',
        username: 'capacity',
        password: 'secret',
      });
    });

    it('requires credentials once a SASL mechanism is named', () => {
      expect(problems({ ...kafka, KAFKA_SASL_MECHANISM: 'plain' })).toEqual([
        expect.stringMatching(/^KAFKA_SASL_USERNAME is required with KAFKA_SASL_MECHANISM/),
        expect.stringMatching(/^KAFKA_SASL_PASSWORD is required with KAFKA_SASL_MECHANISM/),
      ]);
    });
  });

  describe('in production', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      FX_RATES: '{"asOf":"2026-09-19T00:00:00Z","rates":{}}',
    };

    it('refuses the example JWT secret', () => {
      expect(problems({ ...production, JWT_SECRET: EXAMPLE_JWT_SECRET })).toEqual([
        expect.stringMatching(/JWT_SECRET is the example secret/),
      ]);
    });

    it('refuses to reach Kafka unencrypted or unauthenticated', () => {
      expect(
        problems({ ...production, KAFKA_ENABLED: 'true', KAFKA_BROKERS: 'broker:9093' }),
      ).toEqual([
        expect.stringMatching(/^KAFKA_SSL must be true in production/),
        expect.stringMatching(/^KAFKA_SASL_MECHANISM is required in production/),
      ]);
    });

    it('accepts Kafka over TLS with SASL', () => {
      expect(
        loadConfig({
          ...production,
          KAFKA_ENABLED: 'true',
          KAFKA_BROKERS: 'broker:9093',
          KAFKA_SSL: 'true',
          KAFKA_SASL_MECHANISM: 'scram-sha-512',
          KAFKA_SASL_USERNAME: 'capacity',
          KAFKA_SASL_PASSWORD: 'secret',
        }).kafka.enabled,
      ).toBe(true);
    });

    it('requires real exchange rates rather than the development table', () => {
      expect(problems({ ...production, FX_RATES: undefined })).toEqual([
        expect.stringMatching(/FX_RATES is required in production/),
      ]);
    });
  });

  describe('FX_RATES', () => {
    it('reads a rate table', () => {
      const config = loadConfig({
        ...valid,
        FX_RATES: '{"asOf":"2026-09-19T12:00:00Z","rates":{"EUR/USD":"1.10"}}',
      });

      expect(config.fx.rates).toEqual({ 'EUR/USD': '1.10' });
      expect(config.fx.asOf.toISOString()).toBe('2026-09-19T12:00:00.000Z');
    });

    it.each([
      ['not JSON', 'nope', /not valid JSON/],
      ['the wrong shape', '{"EUR/USD":"1.10"}', /must look like/],
    ])('rejects %s', (_, raw, message) => {
      expect(problems({ ...valid, FX_RATES: raw })).toEqual([expect.stringMatching(message)]);
    });
  });
});
