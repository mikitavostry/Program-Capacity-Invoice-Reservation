import { z } from 'zod';
import { Currency } from '../../../../shared/money/currency.js';
import { MAX_MINOR_UNITS, Money } from '../../../../shared/money/money.js';
import { RESERVATION_STATUSES } from '../../domain/reservation.js';
import { MAX_PAGE_SIZE } from '../../application/list-reservations/list-reservations.query.js';

/*
 * Request schemas, parsed straight into domain values such as `Money`. Objects are strict: a
 * misspelt field is refused rather than silently ignored.
 */

/** Ids appear in URLs, so only characters that need no escaping. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const identifier = z
  .string({ error: 'must be a string' })
  .regex(ID_PATTERN, "must be 1–128 characters of letters, digits, '.', '_', ':' or '-'");

/** `{ "amount": "1234.56", "currency": "USD" }`; a JSON number is refused, having been a float. */
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

    let amount: Money;
    try {
      amount = Money.fromDecimal(value.amount, currency);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: (error as Error).message });
      return z.NEVER;
    }
    if (amount.minorUnits > MAX_MINOR_UNITS || -amount.minorUnits > MAX_MINOR_UNITS) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'is too large' });
      return z.NEVER;
    }
    return amount;
  });

export const reserveCapacityBody = z
  .object({ invoiceId: identifier, invoiceAmount: money })
  .strict();

export const recordRepaymentBody = z
  .object({
    repaymentId: identifier,
    /** Omitted or null: repay whatever is outstanding. */
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
