import { HttpStatus } from '@nestjs/common';
import type { ErrorStatusTable } from '../../../../platform/http/problem-details.filter.js';

/**
 * How this context's error codes read over HTTP.
 *
 * 409 means "the request was well-formed but conflicts with the current state" — retrying the
 * same request will not help until something changes. 422 means the request itself carries a
 * value the rules reject. `CAPACITY_BUSY` is the one 503: nothing was wrong with the request,
 * and the same request may well succeed a moment later.
 */
export const CAPACITY_ERROR_STATUSES: ErrorStatusTable = {
  PROGRAM_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESERVATION_NOT_FOUND: HttpStatus.NOT_FOUND,

  INSUFFICIENT_CAPACITY: HttpStatus.CONFLICT,
  PROGRAM_NOT_ACTIVE: HttpStatus.CONFLICT,
  PROGRAM_ALREADY_EXISTS: HttpStatus.CONFLICT,
  INVOICE_ALREADY_RESERVED: HttpStatus.CONFLICT,
  RESERVATION_ALREADY_RELEASED: HttpStatus.CONFLICT,
  REPAYMENT_ID_REUSED: HttpStatus.CONFLICT,

  REPAYMENT_EXCEEDS_OUTSTANDING: HttpStatus.UNPROCESSABLE_ENTITY,
  REPAYMENT_CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,

  INVALID_QUERY: HttpStatus.BAD_REQUEST,

  CAPACITY_BUSY: HttpStatus.SERVICE_UNAVAILABLE,
};
