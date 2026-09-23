import type { INestApplication } from '@nestjs/common';
import { type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { MAX_PAGE_SIZE } from './contexts/capacity/application/list-reservations/list-reservations.query.js';
import {
  healthResponse,
  moneyResponse,
  problemResponse,
  programCapacityResponse,
  repaymentResponse,
  reservationPageResponse,
  reservationResponse,
} from './contexts/capacity/presentation/http/response-schemas.js';
import {
  recordRepaymentBody,
  reserveCapacityBody,
} from './contexts/capacity/presentation/http/schemas.js';

export const API_DOCS_PATH = 'docs';

const schemas = z.registry<{ id: string }>();
schemas.add(moneyResponse, { id: 'Money' });
schemas.add(programCapacityResponse, { id: 'ProgramCapacity' });
schemas.add(reservationResponse, { id: 'Reservation' });
schemas.add(reservationPageResponse, { id: 'ReservationPage' });
schemas.add(repaymentResponse, { id: 'Repayment' });
schemas.add(problemResponse, { id: 'Problem' });
schemas.add(healthResponse, { id: 'Health' });
schemas.add(reserveCapacityBody, { id: 'ReserveCapacityRequest' });
schemas.add(recordRepaymentBody, { id: 'RecordRepaymentRequest' });

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
const json = (schema: object) => ({ 'application/json': { schema } });

function problems(statuses: Record<number, string>) {
  return Object.fromEntries(
    Object.entries(statuses).map(([status, description]) => [
      status,
      { description, content: { 'application/problem+json': { schema: ref('Problem') } } },
    ]),
  );
}

const AUTH_ERRORS = {
  401: 'No valid bearer token (`UNAUTHENTICATED`).',
  403: 'The token lacks the scope, or may not act on this program (`FORBIDDEN`).',
};

const programIdParameter = {
  name: 'programId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' },
  description: 'The program, as treasury identifies it.',
};

export function buildApiDocument(): OpenAPIObject {
  const { schemas: components } = z.toJSONSchema(schemas, {
    target: 'openapi-3.0',
    io: 'input',
    uri: (id) => `#/components/schemas/${id}`,
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'Program Capacity & Invoice Reservation',
      version: '1.0.0',
      description:
        'Tracks how much of a financing program’s credit limit is reserved by invoices. ' +
        'Programs, their limits and their status come from the treasury system over Kafka; ' +
        'over HTTP, clients reserve capacity, record repayments and read availability.\n\n' +
        'Amounts are always `{ "amount": "<decimal string>", "currency": "<ISO 4217>" }`. ' +
        'Errors are RFC 9457 `application/problem+json` with a stable `code`.',
    },
    components: {
      schemas: components as NonNullable<OpenAPIObject['components']>['schemas'],
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'HS256 JWT. Claims: `sub`, `iss`, `aud`, `exp`; `scope` (space-separated: ' +
            '`capacity:read`, `reservations:write`, `repayments:write`); `programs` ' +
            '(`"*"` or a list of program ids).',
        },
      },
    },
    security: [{ bearer: [] }],
    tags: [{ name: 'Capacity' }, { name: 'Health' }],
    paths: {
      '/programs/{programId}/capacity': {
        get: {
          tags: ['Capacity'],
          operationId: 'getProgramCapacity',
          summary: 'Current limit, reserved amount and availability',
          description: 'Scope: `capacity:read`.',
          parameters: [programIdParameter],
          responses: {
            200: { description: 'The program’s capacity.', content: json(ref('ProgramCapacity')) },
            ...problems({ ...AUTH_ERRORS, 404: 'Treasury has not published this program.' }),
          },
        },
      },
      '/programs/{programId}/reservations': {
        get: {
          tags: ['Capacity'],
          operationId: 'listReservations',
          summary: 'The program’s reservations, newest first',
          description: 'Scope: `capacity:read`. Cursor-paged: pass `nextCursor` back as `cursor`.',
          parameters: [
            programIdParameter,
            {
              name: 'status',
              in: 'query' as const,
              schema: { type: 'string', enum: ['ACTIVE', 'RELEASED'] },
            },
            {
              name: 'limit',
              in: 'query' as const,
              schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
            },
            { name: 'cursor', in: 'query' as const, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'A page of reservations.', content: json(ref('ReservationPage')) },
            ...problems({
              400: 'An invalid query parameter (`VALIDATION_FAILED`) or cursor (`INVALID_QUERY`).',
              ...AUTH_ERRORS,
              404: 'No such program (`PROGRAM_NOT_FOUND`).',
            }),
          },
        },
        post: {
          tags: ['Capacity'],
          operationId: 'reserveCapacity',
          summary: 'Reserve capacity for an approved invoice',
          description:
            'Scope: `reservations:write`. Holds the invoice’s full amount, converted into the ' +
            'program’s currency if needed. Repeating the request for the same invoice and amount ' +
            '(and `reservationKey`, if one was sent) returns the existing reservation with 200. ' +
            'Once an invoice’s reservation has been fully repaid, reserving it again requires a ' +
            'new `reservationKey`; without one the request is refused as a possible late retry.',
          parameters: [programIdParameter],
          requestBody: { required: true, content: json(ref('ReserveCapacityRequest')) },
          responses: {
            201: { description: 'Reserved.', content: json(ref('Reservation')) },
            200: {
              description: 'A repeat: the existing reservation.',
              content: json(ref('Reservation')),
            },
            ...problems({
              400: 'An invalid body (`VALIDATION_FAILED`, `MALFORMED_JSON`).',
              ...AUTH_ERRORS,
              404: 'No such program (`PROGRAM_NOT_FOUND`).',
              409: 'It does not fit (`INSUFFICIENT_CAPACITY`), the program is suspended (`PROGRAM_NOT_ACTIVE`), the invoice holds a reservation this request does not repeat (`INVOICE_ALREADY_RESERVED`), or it was fully repaid and no new `reservationKey` was sent (`INVOICE_ALREADY_REPAID`).',
              413: 'The body is too large (`PAYLOAD_TOO_LARGE`).',
              422: 'No rate to convert the invoice’s currency (`CURRENCY_NOT_CONVERTIBLE`), or an invalid amount.',
              503: 'The program is busy; retry after `Retry-After` seconds (`CAPACITY_BUSY`).',
            }),
          },
        },
      },
      '/programs/{programId}/reservations/{invoiceId}/repayments': {
        post: {
          tags: ['Capacity'],
          operationId: 'recordRepayment',
          summary: 'Record a repayment, releasing capacity',
          description:
            'Scope: `repayments:write`. Omit `amount` to repay whatever is outstanding. ' +
            'Repeating a `repaymentId` returns the original result with 200.',
          parameters: [
            programIdParameter,
            { name: 'invoiceId', in: 'path' as const, required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: json(ref('RecordRepaymentRequest')) },
          responses: {
            201: { description: 'Applied.', content: json(ref('Repayment')) },
            200: { description: 'A repeat of this repayment id.', content: json(ref('Repayment')) },
            ...problems({
              400: 'An invalid body (`VALIDATION_FAILED`, `MALFORMED_JSON`).',
              ...AUTH_ERRORS,
              404: 'Nothing to repay for this invoice (`RESERVATION_NOT_FOUND`).',
              409: 'The repayment id was used for something else (`REPAYMENT_ID_REUSED`), or the reservation is already released.',
              413: 'The body is too large (`PAYLOAD_TOO_LARGE`).',
              422: 'More than is outstanding (`REPAYMENT_EXCEEDS_OUTSTANDING`), or in the wrong currency (`REPAYMENT_CURRENCY_MISMATCH`).',
              503: 'The program is busy; retry after `Retry-After` seconds (`CAPACITY_BUSY`).',
            }),
          },
        },
      },
      '/health/live': {
        get: {
          tags: ['Health'],
          operationId: 'live',
          summary: 'Liveness: the process is up',
          security: [],
          responses: { 200: { description: 'Up.', content: json(ref('Health')) } },
        },
      },
      '/health/ready': {
        get: {
          tags: ['Health'],
          operationId: 'ready',
          summary: 'Readiness: the database is reachable',
          security: [],
          responses: {
            200: { description: 'Ready.', content: json(ref('Health')) },
            503: { description: 'The database is unreachable.' },
          },
        },
      },
    },
  };
}

export function setupApiDocs(app: INestApplication): void {
  SwaggerModule.setup(API_DOCS_PATH, app, buildApiDocument(), {
    jsonDocumentUrl: `${API_DOCS_PATH}/openapi.json`,
    customSiteTitle: 'Program Capacity API',
  });
}
