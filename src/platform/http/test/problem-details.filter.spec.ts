import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProblemDetailsFilter } from '../problem-details.filter.js';

/** Runs the filter against a fake Express response and returns what it sent. */
function render(error: unknown) {
  const sent: { status?: number; headers: Record<string, string>; body?: Record<string, unknown> } =
    { headers: {} };
  const response = {
    setHeader: (name: string, value: string) => void (sent.headers[name] = value),
    status(code: number) {
      sent.status = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  };
  const request = { method: 'POST', originalUrl: '/programs/program-1/reservations' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter({}).catch(error, host);
  return sent;
}

describe('ProblemDetailsFilter', () => {
  it('answers a database outage with a retryable 503, not a 500', () => {
    const outage = Object.assign(new Error("Can't reach database server at postgres:5432"), {
      name: 'PrismaClientKnownRequestError',
      code: 'P1001',
    });

    const sent = render(outage);

    expect(sent.status).toBe(503);
    expect(sent.headers['Retry-After']).toBe('5');
    expect(sent.body).toMatchObject({ code: 'DATABASE_UNAVAILABLE', status: 503 });
    // Nothing about the infrastructure leaks into the response.
    expect(JSON.stringify(sent.body)).not.toContain('postgres');
  });

  it('still answers a genuine bug with a 500 that reveals nothing', () => {
    const sent = render(new TypeError('cannot read properties of undefined'));

    expect(sent.status).toBe(500);
    expect(sent.headers['Retry-After']).toBeUndefined();
    expect(sent.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    });
  });
});
