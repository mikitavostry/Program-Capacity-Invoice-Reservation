import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrisma, truncateAll } from '../integration/database.js';
import type { PrismaClient } from '../../src/platform/prisma/prisma-client.js';
import { createTestApp, token, unsignedToken, type TestApp } from './test-app.js';

const usd = (amount: string) => ({ amount, currency: 'USD' });
const eur = (amount: string) => ({ amount, currency: 'EUR' });

describe('capacity API', () => {
  let testApp: TestApp;
  let prisma: PrismaClient;
  let admin: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = createTestPrisma();
    admin = await token();
  });

  afterAll(async () => {
    await testApp.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const http = () => request(testApp.app.getHttpServer());

  async function openProgram(programId = 'program-1', limit = usd('1000.00')) {
    await http()
      .post('/programs')
      .auth(admin, { type: 'bearer' })
      .send({ programId, creditLimit: limit })
      .expect(201);
  }

  const reserve = (body: object, programId = 'program-1', bearer = admin) =>
    http().post(`/programs/${programId}/reservations`).auth(bearer, { type: 'bearer' }).send(body);

  const repay = (invoiceId: string, body: object, programId = 'program-1') =>
    http()
      .post(`/programs/${programId}/reservations/${invoiceId}/repayments`)
      .auth(admin, { type: 'bearer' })
      .send(body);

  describe('health', () => {
    it('answers liveness and readiness without credentials', async () => {
      await http().get('/health/live').expect(200, { status: 'ok' });
      await http().get('/health/ready').expect(200, { status: 'ok' });
    });
  });

  describe('authentication', () => {
    it('requires a bearer token, and says how to supply one', async () => {
      const response = await http().get('/programs/program-1/capacity').expect(401);

      expect(response.headers['www-authenticate']).toBe('Bearer realm="invoice-reservation"');
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    });

    it.each([
      ['has expired', () => token({ expiresAt: Math.floor(Date.now() / 1000) - 3600 })],
      ['was issued for another audience', () => token({ audience: 'some-other-service' })],
      ['was issued by someone else', () => token({ issuer: 'someone-else' })],
      ['was signed with another key', () => token({ secret: 'x'.repeat(48) })],
      ['is not signed at all (alg: none)', async () => unsignedToken()],
      ['is not a token', async () => 'not-a-jwt'],
    ])('refuses a token that %s, without saying which check failed', async (_, make) => {
      const response = await http()
        .get('/programs/program-1/capacity')
        .auth(await make(), { type: 'bearer' })
        .expect(401);

      expect(response.body.detail).toBe('The bearer token is not valid.');
    });
  });

  describe('authorization', () => {
    beforeEach(() => openProgram());

    it('refuses a caller without the scope the operation needs', async () => {
      const readOnly = await token({ scope: 'capacity:read' });

      const response = await reserve(
        { invoiceId: 'invoice-1', amount: usd('10.00') },
        'program-1',
        readOnly,
      ).expect(403);

      expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
      expect(response.body.detail).toMatch(/capacity:write/);
    });

    it('refuses a caller acting on a program it was not granted', async () => {
      const elsewhere = await token({ programs: ['program-2'] });

      await http()
        .get('/programs/program-1/capacity')
        .auth(elsewhere, { type: 'bearer' })
        .expect(403);
    });

    it('grants no programs to a token that does not name any', async () => {
      const noPrograms = await token({ programs: null });

      await http()
        .get('/programs/program-1/capacity')
        .auth(noPrograms, { type: 'bearer' })
        .expect(403);
    });

    it('lets a caller reach a program it was granted by name', async () => {
      const named = await token({ programs: ['program-1'], scope: 'capacity:read' });

      await http().get('/programs/program-1/capacity').auth(named, { type: 'bearer' }).expect(200);
    });

    it('reserves opening programs for administrators', async () => {
      const writer = await token({ scope: 'capacity:read capacity:write' });

      await http()
        .post('/programs')
        .auth(writer, { type: 'bearer' })
        .send({ programId: 'program-9', creditLimit: usd('1.00') })
        .expect(403);
    });
  });

  describe('programs', () => {
    it('opens a program, and answers a repeat of the same request with 200', async () => {
      const body = { programId: 'program-1', creditLimit: usd('10000000.00') };

      const created = await http().post('/programs').auth(admin, { type: 'bearer' }).send(body);
      const repeated = await http().post('/programs').auth(admin, { type: 'bearer' }).send(body);

      expect(created.status).toBe(201);
      expect(repeated.status).toBe(200);
      expect(created.body).toEqual({
        programId: 'program-1',
        currency: 'USD',
        status: 'ACTIVE',
        creditLimit: usd('10000000.00'),
        reservedAmount: usd('0.00'),
        availableCapacity: usd('10000000.00'),
      });
    });

    it('refuses to reopen a program id with a different limit', async () => {
      await openProgram('program-1', usd('1000.00'));

      const response = await http()
        .post('/programs')
        .auth(admin, { type: 'bearer' })
        .send({ programId: 'program-1', creditLimit: usd('2000.00') })
        .expect(409);

      expect(response.body.code).toBe('PROGRAM_ALREADY_EXISTS');
    });

    it('reports a program that does not exist as 404', async () => {
      const response = await http()
        .get('/programs/missing/capacity')
        .auth(admin, { type: 'bearer' })
        .expect(404);

      expect(response.body.code).toBe('PROGRAM_NOT_FOUND');
    });
  });

  describe('reservations', () => {
    beforeEach(() => openProgram());

    it('reserves an invoice in another currency and shows the rate it used', async () => {
      const response = await reserve({ invoiceId: 'invoice-1', amount: eur('100.00') }).expect(201);

      expect(response.body).toMatchObject({
        invoiceId: 'invoice-1',
        status: 'ACTIVE',
        invoiceAmount: eur('100.00'),
        reservedAmount: usd('109.00'),
        heldAmount: usd('109.00'),
        exchangeRate: { from: 'EUR', to: 'USD', rate: '1.09000000' },
        releasedAt: null,
      });

      const capacity = await http()
        .get('/programs/program-1/capacity')
        .auth(admin, { type: 'bearer' })
        .expect(200);
      expect(capacity.body.availableCapacity).toEqual(usd('891.00'));
    });

    it('answers a repeated reservation with the same one and 200', async () => {
      const body = { invoiceId: 'invoice-1', amount: usd('100.00') };

      const first = await reserve(body).expect(201);
      const second = await reserve(body).expect(200);

      expect(second.body.reservationId).toBe(first.body.reservationId);
    });

    it('refuses a second reservation for the invoice with a different amount', async () => {
      await reserve({ invoiceId: 'invoice-1', amount: usd('100.00') }).expect(201);

      const response = await reserve({ invoiceId: 'invoice-1', amount: usd('200.00') }).expect(409);

      expect(response.body.code).toBe('INVOICE_ALREADY_RESERVED');
    });

    it('refuses what does not fit, and says what was asked for and what is left', async () => {
      const response = await reserve({ invoiceId: 'invoice-1', amount: usd('1000.01') }).expect(
        409,
      );

      expect(response.body).toMatchObject({
        code: 'INSUFFICIENT_CAPACITY',
        requested: usd('1000.01'),
        available: usd('1000.00'),
      });
    });

    it('reports every problem with a request body, each at its path', async () => {
      const response = await reserve({
        invoiceId: 'has spaces',
        amount: { amount: 12.5, currency: 'USD' },
        ammount: '1',
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'body.invoiceId' }),
          expect.objectContaining({
            path: 'body.amount.amount',
            message: expect.stringMatching(/not a number/),
          }),
          expect.objectContaining({ path: 'body', message: expect.stringMatching(/ammount/) }),
        ]),
      );
    });

    it.each([
      ['more decimals than the currency has', usd('1.001'), /at most 2 decimal places/],
      ['an unknown currency', { amount: '1.00', currency: 'XYZ' }, /not supported/],
    ])('refuses an amount with %s', async (_, amount, message) => {
      const response = await reserve({ invoiceId: 'invoice-1', amount }).expect(400);

      expect(response.body.issues[0].message).toMatch(message);
    });

    it('refuses a body that is not JSON', async () => {
      const response = await http()
        .post('/programs/program-1/reservations')
        .auth(admin, { type: 'bearer' })
        .set('Content-Type', 'application/json')
        .send('{"invoiceId":')
        .expect(400);

      expect(response.body.code).toBe('MALFORMED_JSON');
    });

    it('refuses a body larger than any legitimate request', async () => {
      const response = await reserve({
        invoiceId: 'invoice-1',
        amount: usd('10.00'),
        padding: 'x'.repeat(32 * 1024),
      }).expect(413);

      expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('lists reservations a page at a time, newest first', async () => {
      for (const invoiceId of ['invoice-1', 'invoice-2', 'invoice-3']) {
        await reserve({ invoiceId, amount: usd('10.00') }).expect(201);
      }

      const first = await http()
        .get('/programs/program-1/reservations?limit=2')
        .auth(admin, { type: 'bearer' })
        .expect(200);
      const second = await http()
        .get(`/programs/program-1/reservations?limit=2&cursor=${first.body.nextCursor}`)
        .auth(admin, { type: 'bearer' })
        .expect(200);

      const ids = [...first.body.items, ...second.body.items].map(
        (item: { invoiceId: string }) => item.invoiceId,
      );
      expect(new Set(ids)).toEqual(new Set(['invoice-1', 'invoice-2', 'invoice-3']));
      expect(first.body.items).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();
    });

    it.each([
      ['a page size out of range', 'limit=500'],
      ['a cursor it did not issue', 'cursor=forged'],
      ['an unknown status', 'status=PENDING'],
      ['an unknown parameter', 'sort=amount'],
    ])('refuses a list query with %s', async (_, query) => {
      await http()
        .get(`/programs/program-1/reservations?${query}`)
        .auth(admin, { type: 'bearer' })
        .expect(400);
    });
  });

  describe('repayments', () => {
    beforeEach(async () => {
      await openProgram();
      await reserve({ invoiceId: 'invoice-1', amount: usd('100.00') }).expect(201);
    });

    it('applies a partial repayment and answers a replay of it with 200', async () => {
      const body = { repaymentId: 'repayment-1', amount: usd('40.00') };

      const applied = await repay('invoice-1', body).expect(201);
      const replayed = await repay('invoice-1', body).expect(200);

      expect(applied.body).toMatchObject({
        repaymentId: 'repayment-1',
        repaidAmount: usd('40.00'),
        releasedAmount: usd('40.00'),
        reservation: { status: 'ACTIVE', outstandingAmount: usd('60.00') },
      });
      expect(replayed.body.releasedAmount).toEqual(usd('40.00'));

      const capacity = await http()
        .get('/programs/program-1/capacity')
        .auth(admin, { type: 'bearer' })
        .expect(200);
      expect(capacity.body.reservedAmount).toEqual(usd('60.00'));
    });

    it('repays whatever is outstanding when no amount is sent', async () => {
      const response = await repay('invoice-1', { repaymentId: 'repayment-1' }).expect(201);

      expect(response.body.reservation).toMatchObject({
        status: 'RELEASED',
        outstandingAmount: usd('0.00'),
      });
      expect(response.body.reservation.releasedAt).not.toBeNull();
    });

    it('refuses a repayment id reused for a different amount', async () => {
      await repay('invoice-1', { repaymentId: 'repayment-1', amount: usd('40.00') }).expect(201);

      const response = await repay('invoice-1', {
        repaymentId: 'repayment-1',
        amount: usd('50.00'),
      }).expect(409);

      expect(response.body.code).toBe('REPAYMENT_ID_REUSED');
    });

    it('refuses an overpayment', async () => {
      const response = await repay('invoice-1', {
        repaymentId: 'repayment-1',
        amount: usd('100.01'),
      }).expect(422);

      expect(response.body).toMatchObject({
        code: 'REPAYMENT_EXCEEDS_OUTSTANDING',
        outstanding: usd('100.00'),
      });
    });

    it('reports an invoice with nothing to repay as 404', async () => {
      const response = await repay('invoice-unknown', { repaymentId: 'repayment-1' }).expect(404);

      expect(response.body.code).toBe('RESERVATION_NOT_FOUND');
    });
  });
});

describe('capacity API under contention', () => {
  let testApp: TestApp;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // An impatient service: gives up on a locked program after 200ms.
    testApp = await createTestApp({ DB_LOCK_TIMEOUT_MS: '200' });
    prisma = createTestPrisma();
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await testApp.close();
    await prisma.$disconnect();
  });

  it('answers 503 with Retry-After when a program stays locked, rather than queueing forever', async () => {
    const bearer = await token();
    await request(testApp.app.getHttpServer())
      .post('/programs')
      .auth(bearer, { type: 'bearer' })
      .send({ programId: 'busy-program', creditLimit: usd('1000.00') })
      .expect(201);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM programs WHERE id = 'busy-program' FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isLocked;

    try {
      const response = await request(testApp.app.getHttpServer())
        .post('/programs/busy-program/reservations')
        .auth(bearer, { type: 'bearer' })
        .send({ invoiceId: 'invoice-1', amount: usd('10.00') })
        .expect(503);

      expect(response.headers['retry-after']).toBe('1');
      expect(response.body.code).toBe('CAPACITY_BUSY');
    } finally {
      release();
      await holder;
    }
  });
});
