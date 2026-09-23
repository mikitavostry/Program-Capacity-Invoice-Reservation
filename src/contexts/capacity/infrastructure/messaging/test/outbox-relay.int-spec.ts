import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrisma, truncateAll } from '../../../../../../test/infrastructure/database.js';
import { createTestApp, token, type TestApp } from '../../../../../../test/e2e/test-app.js';
import { eventually, TreasuryTopic } from '../../../../../../test/support/treasury-kafka.js';
import type { PrismaClient } from '../../../../../platform/prisma/prisma-client.js';

/*
 * The transactional outbox end to end: a change writes its events to the outbox in its own
 * transaction, and the relay publishes them to Kafka and marks them published.
 */

const PROGRAM = 'program-outbox-1';
const usd = (amount: string) => ({ amount, currency: 'USD' });

describe('the outbox relay', () => {
  const treasury = new TreasuryTopic();
  let prisma: PrismaClient;
  let testApp: TestApp;
  let bearer: string;

  beforeAll(async () => {
    await treasury.start();
    prisma = createTestPrisma();
    await truncateAll(prisma);
    testApp = await createTestApp(treasury.serviceEnv());
    bearer = await token();

    await treasury.publish({ programId: PROGRAM, sequence: 1, creditLimit: '1000.00' });
    await eventually(() => prisma.program.findUniqueOrThrow({ where: { id: PROGRAM } }));
  });

  afterAll(async () => {
    await testApp?.close();
    await treasury.stop();
    await prisma?.$disconnect();
  });

  const reserve = (invoiceId: string, amount: string) =>
    request(testApp.app.getHttpServer())
      .post(`/programs/${PROGRAM}/reservations`)
      .auth(bearer, { type: 'bearer' })
      .send({ invoiceId, invoiceAmount: usd(amount) });

  it('publishes a program’s events to Kafka in the order they happened, keyed by program', async () => {
    await reserve('invoice-1', '250.00').expect(201);
    await request(testApp.app.getHttpServer())
      .post(`/programs/${PROGRAM}/reservations/invoice-1/repayments`)
      .auth(bearer, { type: 'bearer' })
      .send({ repaymentId: 'repayment-1', amount: usd('100.00') })
      .expect(201);

    const published = await treasury.readCapacityEvents(3);
    const messages = published.map((message) => JSON.parse(String(message.value)));

    expect(messages.map((message) => message.eventType)).toEqual([
      'capacity.program-opened',
      'capacity.reserved',
      'capacity.released',
    ]);
    expect(published.every((message) => String(message.key) === PROGRAM)).toBe(true);
    expect(messages[1]).toMatchObject({
      programId: PROGRAM,
      data: { invoiceId: 'invoice-1', reservedAmount: usd('250.00') },
    });
    expect(String(published[1]?.headers?.['event-id'])).toBe(messages[1].eventId);
  });

  it('marks what it published, so nothing is sent twice', async () => {
    await eventually(async () => {
      await expect(prisma.outboxEvent.count({ where: { publishedAt: null } })).resolves.toBe(0);
    });

    await expect(prisma.outboxEvent.count()).resolves.toBe(3);
  });

  it('writes nothing to the outbox for a change that was refused', async () => {
    const before = await prisma.outboxEvent.count();

    await reserve('invoice-too-big', '5000.00').expect(409);

    await expect(prisma.outboxEvent.count()).resolves.toBe(before);
  });
});
