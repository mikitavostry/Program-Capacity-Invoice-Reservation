import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../../shared/domain/domain-error.js';
import { isDatabaseUnavailable } from '../prisma/database-errors.js';
import { RequestValidationError } from './request-validation.js';

export type ErrorStatusTable = Readonly<Record<string, number>>;

export const SHARED_ERROR_STATUSES: ErrorStatusTable = {
  INVALID_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  UNSUPPORTED_CURRENCY: HttpStatus.UNPROCESSABLE_ENTITY,
  CURRENCY_NOT_CONVERTIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_IDENTIFIER: HttpStatus.BAD_REQUEST,
};

const HTTP_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Errors a client should retry, and after how many seconds. */
const RETRY_AFTER_SECONDS: Readonly<Record<string, number>> = {
  CAPACITY_BUSY: 1,
  DATABASE_UNAVAILABLE: 5,
};

export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly extensions?: Record<string, unknown>;
}

/**
 * Renders every error as RFC 9457 problem details with a stable `code`. Anything unmapped is a
 * 500 whose details go to the log, not the response.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly statuses: ErrorStatusTable) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();

    sendProblem(http.getResponse<Response>(), request, this.toProblem(error, request));
  }

  private toProblem(error: unknown, request: Request): Problem {
    if (error instanceof RequestValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        detail: error.message,
        extensions: { issues: error.issues },
      };
    }

    if (error instanceof DomainError) {
      const status = this.statuses[error.code];
      if (status !== undefined) {
        return { status, code: error.code, detail: error.message, extensions: extensionsOf(error) };
      }
      // An invariant violation or an unmapped code: a bug, not the caller's error.
      return this.unexpected(error, request);
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === HttpStatus.UNAUTHORIZED && error.cause !== undefined) {
        this.logger.warn(
          `Rejected credentials on ${request.method} ${request.originalUrl}: ${String(error.cause)}`,
        );
      }
      return {
        status,
        code: HTTP_CODES[status] ?? `HTTP_${status}`,
        detail: messageOf(error),
      };
    }

    // An outage, not a bug: nothing was written, and the same request can succeed later.
    if (isDatabaseUnavailable(error)) {
      this.logger.warn(
        `Database unavailable on ${request.method} ${request.originalUrl}: ${reasonOf(error)}`,
      );
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'DATABASE_UNAVAILABLE',
        detail: 'The database is temporarily unavailable; nothing was changed. Retry shortly.',
      };
    }

    return this.unexpected(error, request);
  }

  private unexpected(error: unknown, request: Request): Problem {
    this.logger.error(
      `Unhandled error on ${request.method} ${request.originalUrl}`,
      error instanceof Error ? error.stack : String(error),
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    };
  }
}

export function sendProblem(response: Response, request: Request, problem: Problem): void {
  if (problem.status === HttpStatus.UNAUTHORIZED) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="invoice-reservation"');
  }
  const retryAfter = RETRY_AFTER_SECONDS[problem.code];
  if (retryAfter !== undefined) {
    response.setHeader('Retry-After', String(retryAfter));
  }

  response
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: `urn:invoice-reservation:problem:${problem.code.toLowerCase().replaceAll('_', '-')}`,
      title: titleFor(problem.status),
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
      instance: request.originalUrl,
      ...problem.extensions,
    });
}

/** Amounts some domain errors carry, so a client need not parse `detail`. */
function extensionsOf(error: DomainError): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  for (const key of ['requested', 'available', 'repayment', 'outstanding'] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) fields[key] = value;
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

/** Express's body parser reports malformed or oversized bodies as errors carrying a status. */
export function parserFailure(error: unknown): Problem | null {
  if (typeof error !== 'object' || error === null) return null;
  const { type, status } = error as { type?: unknown; status?: unknown };

  if (type === 'entity.parse.failed') {
    return { status: 400, code: 'MALFORMED_JSON', detail: 'The request body is not valid JSON.' };
  }
  if (type === 'entity.too.large' || status === 413) {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', detail: 'The request body is too large.' };
  }
  return null;
}

/** Prisma puts its invocation first and the reason on the last line. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().split('\n').at(-1) ?? text;
}

function messageOf(error: HttpException): string {
  const body = error.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return error.message;
}

function titleFor(status: number): string {
  const name = HttpStatus[status];
  if (typeof name !== 'string') return 'Error';
  return name
    .toLowerCase()
    .split('_')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
