import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrisma, truncateAll } from '../../../../../test/integration/database.js';
import { createTestApp, token, type TestApp } from '../../../../../test/e2e/test-app.js';
import type { PrismaClient } from '../../../../platform/prisma/prisma-client.js';

/*
 * The treasury feed end to end: a real broker, the real consumer, the real handler and a real
 * database. What it is here to prove is everything the unit tests cannot — that the wiring
 * holds, that redelivery and reordering behave as designed, and that a message which can never
 * succeed is parked instead of blocking the partition behind it.
 */

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:19092').split(',');
const PROGRAM = 'program-treasury-1';

interface TreasuryMessageOverrides {
  readonly eventId?: string;
  readonly eventType?: string;
  readonly sequence?: number;
  readonly creditLimit?: string;
  readonly reservedAmount?: string;
  readonly programId?: string;
}

function treasuryMessage(overrides: TreasuryMessageOverrides = {}): string {
  const program: Record<string, unknown> = {
    id: overrides.programId ?? PROGRAM,
    creditLimit: { amount: overrides.creditLimit ?? '2500000.00', currency: 'USD' },
  };
  if (overrides.reservedAmount !== undefined) {
    program['reservedAmount'] = { amount: overrides.reservedAmount, currency: 'USD' };
  }

  return JSON.stringify({
    eventId: overrides.eventId ?? `treasury-${randomUUID()}`,
    eventType: overrides.eventType ?? 'program.capacity.changed',
    occurredAt: new Date().toISOString(),
    sequence: overrides.sequence ?? 1,
    program,
  });
}

/** Polls until `check` stops throwing, so a test waits for the feed rather than for a clock. */
async function eventually<T>(check: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw lastError;
}

describe('the treasury feed', () => {
  const topic = `treasury.test.${randomUUID()}`;
  const deadLetterTopic = `${topic}.dead-letter`;

  let kafka: KafkaJS.Kafka;
  let producer: ReturnType<KafkaJS.Kafka['producer']>;
  let prisma: PrismaClient;
  let testApp: TestApp;

  beforeAll(async () => {
    kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: BROKERS,
        clientId: 'treasury-feed-test',
        logLevel: KafkaJS.logLevel.NOTHING,
      },
    });

    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic, numPartitions: 1 },
        { topic: deadLetterTopic, numPartitions: 1 },
      ],
    });
    await admin.disconnect();

    producer = kafka.producer();
    await producer.connect();

    prisma = createTestPrisma();
    await truncateAll(prisma);

    testApp = await createTestApp({
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: BROKERS.join(','),
      KAFKA_TREASURY_TOPIC: topic,
      KAFKA_DEAD_LETTER_TOPIC: deadLetterTopic,
      KAFKA_GROUP_ID: `treasury-feed-test-${randomUUID()}`,
    });

    await request(testApp.app.getHttpServer())
      .post('/programs')
      .auth(await token(), { type: 'bearer' })
      .send({ programId: PROGRAM, creditLimit: { amount: '1000000.00', currency: 'USD' } })
      .expect(201);
  });

  afterAll(async () => {
    await testApp?.close();
    await producer?.disconnect();
    await prisma?.$disconnect();
  });

  const send = (value: string) => producer.send({ topic, messages: [{ key: PROGRAM, value }] });

  const storedProgram = () => prisma.program.findUniqueOrThrow({ where: { id: PROGRAM } });

  it('applies a capacity change published by treasury', async () => {
    await send(treasuryMessage({ sequence: 10, creditLimit: '2500000.00' }));

    const program = await eventually(async () => {
      const row = await storedProgram();
      expect(row.creditLimitMinor).toBe(250000000n);
      return row;
    });

    expect(program.treasurySequence).toBe(10n);
  });

  it('applies a message only once, however many times it is delivered', async () => {
    const message = treasuryMessage({
      eventId: 'treasury-duplicate',
      sequence: 20,
      creditLimit: '3000000.00',
    });

    await send(message);
    await send(message);
    await send(message);

    await eventually(async () => {
      const rows = await prisma.treasuryEvent.findMany({
        where: { eventId: 'treasury-duplicate' },
      });
      expect(rows).toHaveLength(1);
    });

    const program = await storedProgram();
    expect(program.creditLimitMinor).toBe(300000000n);
    expect(program.treasurySequence).toBe(20n);
  });

  it('ignores a message that arrives after a newer one, and records that it did', async () => {
    await send(
      treasuryMessage({ eventId: 'treasury-newer', sequence: 40, creditLimit: '4000000.00' }),
    );
    await eventually(async () => {
      expect((await storedProgram()).treasurySequence).toBe(40n);
    });

    await send(
      treasuryMessage({ eventId: 'treasury-older', sequence: 30, creditLimit: '9000000.00' }),
    );

    const recorded = await eventually(async () =>
      prisma.treasuryEvent.findUniqueOrThrow({ where: { eventId: 'treasury-older' } }),
    );

    expect(recorded.applied).toBe(false);
    expect(recorded.reason).toMatch(/not newer/);
    expect((await storedProgram()).creditLimitMinor).toBe(400000000n);
  });

  it('reconciles a program without overwriting what it holds reserved', async () => {
    await send(
      treasuryMessage({
        eventId: 'treasury-reconcile',
        eventType: 'program.state.reconciled',
        sequence: 50,
        creditLimit: '5000000.00',
        reservedAmount: '123.45',
      }),
    );

    const recorded = await eventually(async () =>
      prisma.treasuryEvent.findUniqueOrThrow({ where: { eventId: 'treasury-reconcile' } }),
    );

    expect(recorded.kind).toBe('STATE_RECONCILED');
    expect(recorded.applied).toBe(true);
    // Treasury said 123.45 was reserved; we hold nothing, and keep holding nothing.
    expect((await storedProgram()).reservedMinor).toBe(0n);
  });

  describe('messages that can never succeed', () => {
    async function readDeadLetters(expected: number): Promise<KafkaJS.Message[]> {
      const consumer = kafka.consumer({
        kafkaJS: { groupId: `dead-letter-reader-${randomUUID()}`, fromBeginning: true },
      });
      await consumer.connect();
      await consumer.subscribe({ topics: [deadLetterTopic] });

      const collected: KafkaJS.Message[] = [];
      await consumer.run({
        eachMessage: async ({ message }) => {
          collected.push(message);
        },
      });

      try {
        await eventually(async () => expect(collected.length).toBeGreaterThanOrEqual(expected));
        return collected;
      } finally {
        await consumer.disconnect();
      }
    }

    it('parks them with the reason and where they came from, and keeps consuming', async () => {
      await send('{ this is not json');
      await send(treasuryMessage({ programId: 'program-that-does-not-exist', sequence: 1 }));

      const parked = await readDeadLetters(2);
      const reasons = parked.map((message) => String(message.headers?.['x-dead-letter-reason']));

      expect(reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('not valid JSON'),
          expect.stringContaining('PROGRAM_NOT_FOUND'),
        ]),
      );
      expect(String(parked[0]?.headers?.['x-original-topic'])).toBe(topic);

      // The feed carried on: a message published after the poison ones is still applied.
      await send(
        treasuryMessage({
          eventId: 'treasury-after-poison',
          sequence: 60,
          creditLimit: '6000000.00',
        }),
      );
      await eventually(async () => {
        expect((await storedProgram()).creditLimitMinor).toBe(600000000n);
      });
    });
  });
});
