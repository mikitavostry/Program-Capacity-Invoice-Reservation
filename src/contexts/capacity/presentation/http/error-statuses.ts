import { HttpStatus } from '@nestjs/common';
import type { ErrorStatusTable } from '../../../../platform/http/problem-details.filter.js';

/**
 * 409: conflicts with the current state. 422: the request carries a value the rules reject.
 * 503 (`CAPACITY_BUSY`): nothing was wrong, and a retry may succeed.
 */
export const CAPACITY_ERROR_STATUSES: ErrorStatusTable = {
  PROGRAM_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESERVATION_NOT_FOUND: HttpStatus.NOT_FOUND,

  INSUFFICIENT_CAPACITY: HttpStatus.CONFLICT,
  PROGRAM_NOT_ACTIVE: HttpStatus.CONFLICT,
  INVOICE_ALREADY_RESERVED: HttpStatus.CONFLICT,
  INVOICE_ALREADY_REPAID: HttpStatus.CONFLICT,
  RESERVATION_ALREADY_RELEASED: HttpStatus.CONFLICT,
  REPAYMENT_ID_REUSED: HttpStatus.CONFLICT,

  REPAYMENT_EXCEEDS_OUTSTANDING: HttpStatus.UNPROCESSABLE_ENTITY,
  REPAYMENT_CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,

  INVALID_QUERY: HttpStatus.BAD_REQUEST,

  CAPACITY_BUSY: HttpStatus.SERVICE_UNAVAILABLE,
};
