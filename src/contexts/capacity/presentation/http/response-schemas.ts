import { z } from 'zod';
import { PROGRAM_STATUSES } from '../../domain/program.js';
import { RESERVATION_STATUSES } from '../../domain/reservation.js';

/*
 * What `presenters.ts` produces, for the OpenAPI document. The e2e tests parse real responses
 * with these, so the documentation cannot drift from the code.
 */

export const moneyResponse = z
  .object({
    amount: z.string().describe('Decimal string, with the currency’s own number of decimals.'),
    currency: z.string().describe('ISO 4217 code.'),
  })
  .strict();

export const programCapacityResponse = z
  .object({
    programId: z.string(),
    currency: z.string(),
    status: z.enum(PROGRAM_STATUSES),
    creditLimit: moneyResponse,
    reservedAmount: moneyResponse,
    availableCapacity: moneyResponse.describe(
      'creditLimit − reservedAmount; negative when treasury cut the limit below what is held.',
    ),
  })
  .strict();

export const exchangeRateResponse = z
  .object({
    from: z.string(),
    to: z.string(),
    rate: z.string().describe('Decimal string, eight decimal places.'),
    asOf: z.iso.datetime().describe('When the rate was observed.'),
  })
  .strict();

export const reservationResponse = z
  .object({
    reservationId: z.string(),
    programId: z.string(),
    invoiceId: z.string(),
    reservationKey: z
      .string()
      .nullable()
      .describe('The key the reservation was made under; null when none was sent.'),
    status: z.enum(RESERVATION_STATUSES),
    invoiceAmount: moneyResponse.describe('In the invoice’s currency.'),
    reservedAmount: moneyResponse.describe('Held against the limit, in the program’s currency.'),
    exchangeRate: exchangeRateResponse
      .nullable()
      .describe('The rate the invoice was converted at; null when no conversion was needed.'),
    repaidAmount: moneyResponse,
    releasedAmount: moneyResponse,
    outstandingAmount: moneyResponse,
    heldAmount: moneyResponse,
    reservedAt: z.iso.datetime(),
    releasedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const reservationPageResponse = z
  .object({
    items: z.array(reservationResponse),
    nextCursor: z.string().nullable().describe('Pass back as `cursor`; null on the last page.'),
  })
  .strict();

export const repaymentResponse = z
  .object({
    repaymentId: z.string(),
    repaidAmount: moneyResponse,
    releasedAmount: moneyResponse.describe('Capacity freed, in the program’s currency.'),
    reservation: reservationResponse,
  })
  .strict();

export const problemResponse = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string().describe('Stable; branch on this rather than on `detail`.'),
    detail: z.string(),
    instance: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Every validation problem, each at its path.'),
    requested: moneyResponse.optional(),
    available: moneyResponse.optional(),
    repayment: moneyResponse.optional(),
    outstanding: moneyResponse.optional(),
  })
  .describe('Further fields may appear alongside these, as RFC 9457 allows.');

export const healthResponse = z.object({ status: z.string() }).strict();
