import { z } from 'zod';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { RESERVATION_STATUSES } from '../../domain/reservation.js';
import { MAX_PAGE_SIZE } from '../../application/list-reservations/list-reservations.query.js';

/*
 * Request shapes, parsed straight into domain values: a request that gets past these schemas
 * already holds `Money`, never a string that some later layer might forget to check.
 *
 * Objects are `.strict()`. In a money API a misspelt field — `ammount` — that is silently
 * ignored is far worse than one that is refused.
 */

/** Ids appear in URLs, so they are kept to characters that need no escaping. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const identifier = z
  .string({ error: 'must be a string' })
  .regex(ID_PATTERN, "must be 1–128 characters of letters, digits, '.', '_', ':' or '-'");

/**
 * `{ "amount": "1234.56", "currency": "USD" }`. The amount must be a string: a JSON number has
 * already been through a binary float by the time it arrives, and may not be the number sent.
 */
export const money = z
  .object({
    amount: z.string({ error: 'must be a decimal string such as "1234.56", not a number' }),
    currency: z.string({ error: 'must be an ISO 4217 code such as "USD"' }),
  })
  .strict()
  .transform((value, ctx): Money => {
    let currency: Currency;
    try {
      currency = Currency.of(value.currency);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['currency'], message: (error as Error).message });
      return z.NEVER;
    }

    try {
      return Money.fromDecimal(value.amount, currency);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: (error as Error).message });
      return z.NEVER;
    }
  });

export const openProgramBody = z.object({ programId: identifier, creditLimit: money }).strict();

export const reserveCapacityBody = z.object({ invoiceId: identifier, amount: money }).strict();

export const recordRepaymentBody = z
  .object({
    repaymentId: identifier,
    /** Omit (or send null) to repay whatever is outstanding. */
    amount: money.nullish(),
  })
  .strict();

export const listReservationsQuery = z
  .object({
    status: z.enum(RESERVATION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();
