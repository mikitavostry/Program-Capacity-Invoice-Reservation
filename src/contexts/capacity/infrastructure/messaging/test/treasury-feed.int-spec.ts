import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrisma, truncateAll } from '../../../../../../test/infrastructure/database.js';
import { createTestApp, type TestApp } from '../../../../../../test/e2e/test-app.js';
import {
  eventually,
  treasuryMessage,
  TreasuryTopic,
} from '../../../../../../test/support/treasury-kafka.js';
import { MissingTopicsError } from '../../../../../platform/kafka/kafka-client.js';
import type { PrismaClient } from '../../../../../platform/prisma/prisma-client.js';

/* The treasury feed against a real broker and database: wiring, redelivery, dead letters. */

const PROGRAM = 'program-treasury-1';

describe('the treasury feed', () => {
  const treasury = new TreasuryTopic();
  let prisma: PrismaClient;
  let testApp: TestApp;

  beforeAll(async () => {
    await treasury.start();
    prisma = createTestPrisma();
    await truncateAll(prisma);
    testApp = await createTestApp(treasury.serviceEnv());
  });

  afterAll(async () => {
    await testApp?.close();
    await treasury.stop();
    await prisma?.$disconnect();
  });

  const storedProgram = () => prisma.program.findUniqueOrThrow({ where: { id: PROGRAM } });

  it('opens a program from the first message that mentions it', async () => {
    await treasury.publish({
      programId: PROGRAM,
      eventId: 'treasury-opening',
      sequence: 1,
      creditLimit: '1000000.00',
    });

    const program = await eventually(storedProgram);

    expect(program).toMatchObject({
      currency: 'USD',
      creditLimitMinor: 100000000n,
      reservedMinor: 0n,
      status: 'ACTIVE',
      treasurySequence: 1n,
    });
    await expect(
      prisma.treasuryEvent.findUniqueOrThrow({ where: { eventId: 'treasury-opening' } }),
    ).resolves.toMatchObject({ applied: true, kind: 'CAPACITY_CHANGED' });
  });

  it('applies a capacity change to a program it already holds', async () => {
    await treasury.publish({ programId: PROGRAM, sequence: 10, creditLimit: '2500000.00' });

    const program = await eventually(async () => {
      const row = await storedProgram();
      expect(row.creditLimitMinor).toBe(250000000n);
      return row;
    });

    expect(program.treasurySequence).toBe(10n);
  });

  it('applies a message only once, however many times it is delivered', async () => {
    const message = treasuryMessage({
      programId: PROGRAM,
      eventId: 'treasury-duplicate',
      sequence: 20,
      creditLimit: '3000000.00',
    });

    await treasury.send(message, PROGRAM);
    await treasury.send(message, PROGRAM);
    await treasury.send(message, PROGRAM);

    await eventually(async () => {
      expect((await storedProgram()).treasurySequence).toBe(20n);
    });
    // A later message is the marker that every copy before it has been consumed.
    await treasury.publish({ programId: PROGRAM, eventId: 'treasury-marker', sequence: 21 });
    await eventually(async () => {
      expect((await storedProgram()).treasurySequence).toBe(21n);
    });

    const rows = await prisma.treasuryEvent.findMany({ where: { eventId: 'treasury-duplicate' } });
    expect(rows).toHaveLength(1);
  });

  it('ignores a message that arrives after a newer one, and records that it did', async () => {
    await treasury.publish({
      programId: PROGRAM,
      eventId: 'treasury-newer',
      sequence: 40,
      creditLimit: '4000000.00',
    });
    await eventually(async () => {
      expect((await storedProgram()).treasurySequence).toBe(40n);
    });

    await treasury.publish({
      programId: PROGRAM,
      eventId: 'treasury-older',
      sequence: 30,
      creditLimit: '9000000.00',
    });

    const recorded = await eventually(async () =>
      prisma.treasuryEvent.findUniqueOrThrow({ where: { eventId: 'treasury-older' } }),
    );

    expect(recorded.applied).toBe(false);
    expect(recorded.reason).toMatch(/not newer/);
    expect((await storedProgram()).creditLimitMinor).toBe(400000000n);
  });

  it('applies a periodic reconciliation, recorded as one', async () => {
    await treasury.publish({
      programId: PROGRAM,
      eventId: 'treasury-reconcile',
      sequence: 50,
      creditLimit: '5000000.00',
      status: 'ACTIVE',
      reconciliation: true,
    });

    const recorded = await eventually(async () =>
      prisma.treasuryEvent.findUniqueOrThrow({ where: { eventId: 'treasury-reconcile' } }),
    );

    expect(recorded.kind).toBe('STATE_RECONCILED');
    expect(recorded.applied).toBe(true);
    expect((await storedProgram()).creditLimitMinor).toBe(500000000n);
  });

  it('suspends and reactivates a program when treasury says so', async () => {
    const { creditLimitMinor } = await storedProgram();
    await treasury.publish({ programId: PROGRAM, sequence: 55, status: 'SUSPENDED' });
    await eventually(async () => {
      expect((await storedProgram()).status).toBe('SUSPENDED');
    });

    await treasury.publish({ programId: PROGRAM, sequence: 56, status: 'ACTIVE' });
    await eventually(async () => {
      expect((await storedProgram()).status).toBe('ACTIVE');
    });
    // A status change carries no limit, so the limit is untouched.
    expect((await storedProgram()).creditLimitMinor).toBe(creditLimitMinor);
  });

  describe('messages that can never succeed', () => {
    it('parks them with the reason and where they came from, and keeps consuming', async () => {
      await treasury.send('{ this is not json', PROGRAM);
      await treasury.publish({
        programId: 'program-with-no-limit',
        sequence: 1,
        creditLimit: '0.00',
      });
      // The program is in USD; its currency cannot change, so this can never apply.
      await treasury.publish({
        programId: PROGRAM,
        sequence: 58,
        creditLimit: '5000000.00',
        currency: 'EUR',
      });

      // A status change cannot open a program: there is no limit to open it with.
      await treasury.publish({ programId: 'program-never-opened', sequence: 1, status: 'ACTIVE' });

      const parked = await treasury.readDeadLetters(4);
      const reasons = parked.map((message) => String(message.headers?.['x-dead-letter-reason']));

      expect(reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('not valid JSON'),
          expect.stringContaining('INVALID_AMOUNT'),
          expect.stringContaining('TREASURY_CURRENCY_MISMATCH'),
          expect.stringContaining('PROGRAM_NOT_FOUND'),
        ]),
      );
      expect(String(parked[0]?.headers?.['x-original-topic'])).toBe(treasury.topic);
      await expect(
        prisma.program.findUnique({ where: { id: 'program-with-no-limit' } }),
      ).resolves.toBeNull();
      await expect(
        prisma.program.findUnique({ where: { id: 'program-never-opened' } }),
      ).resolves.toBeNull();

      // The feed carried on: a message published after the poison ones is still applied.
      await treasury.publish({
        programId: PROGRAM,
        eventId: 'treasury-after-poison',
        sequence: 60,
        creditLimit: '6000000.00',
      });
      await eventually(async () => {
        expect((await storedProgram()).creditLimitMinor).toBe(600000000n);
      });
    });
  });

  describe('a message that fails for a reason that may clear', () => {
    it('holds back the messages behind it, then applies them all in order', async () => {
      // Another transaction holds the program's row lock, so applying treasury's next message
      // times out with CAPACITY_BUSY until it is released.
      let release!: () => void;
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM programs WHERE id = ${PROGRAM} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 },
      );
      await lockTaken;

      await treasury.publish({
        programId: PROGRAM,
        eventId: 'treasury-blocked',
        sequence: 70,
        creditLimit: '7000000.00',
      });
      await treasury.publish({
        programId: PROGRAM,
        eventId: 'treasury-behind-blocked',
        sequence: 71,
        creditLimit: '7100000.00',
      });

      // Two lock timeouts' worth: long enough for the feed to have skipped ahead if it could.
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      await expect(
        prisma.treasuryEvent.findMany({
          where: { eventId: { in: ['treasury-blocked', 'treasury-behind-blocked'] } },
        }),
      ).resolves.toEqual([]);

      release();
      await holder;

      const recorded = await eventually(async () => {
        const rows = await prisma.treasuryEvent.findMany({
          where: { eventId: { in: ['treasury-blocked', 'treasury-behind-blocked'] } },
          orderBy: { sequence: 'asc' },
        });
        expect(rows).toHaveLength(2);
        return rows;
      }, 30_000);

      // Had the later message gone first, the earlier one would have been recorded as stale.
      expect(recorded.map((row) => [row.eventId, row.applied])).toEqual([
        ['treasury-blocked', true],
        ['treasury-behind-blocked', true],
      ]);
      expect((await storedProgram()).creditLimitMinor).toBe(710000000n);
    }, 60_000);
  });
});

describe('the treasury feed at startup', () => {
  it('refuses to start when a topic it needs has not been provisioned', async () => {
    const treasury = await new TreasuryTopic().start();
    try {
      const unprovisioned = `${treasury.topic}.never-created`;

      await expect(
        createTestApp({ ...treasury.serviceEnv(), KAFKA_TREASURY_TOPIC: unprovisioned }),
      ).rejects.toThrow(new MissingTopicsError([unprovisioned]));
    } finally {
      await treasury.stop();
    }
  });
});
