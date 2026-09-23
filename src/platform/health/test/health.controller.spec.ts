import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../prisma/prisma-client.js';
import { HealthController } from '../health.controller.js';

function controllerWith(query: () => Promise<unknown>) {
  const prisma = { $queryRaw: query } as unknown as PrismaClient;
  const response = { status: vi.fn() };
  return { controller: new HealthController(prisma), response };
}

describe('HealthController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is ready when the database answers', async () => {
    const { controller, response } = controllerWith(() => Promise.resolve([{ '?column?': 1 }]));

    await expect(controller.ready(response as unknown as Response)).resolves.toEqual({
      status: 'ok',
    });
    expect(response.status).not.toHaveBeenCalled();
  });

  it('is unready when the database refuses', async () => {
    const { controller, response } = controllerWith(() => Promise.reject(new Error('refused')));

    await expect(controller.ready(response as unknown as Response)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('answers unready within two seconds when the database does not answer at all', async () => {
    const { controller, response } = controllerWith(() => new Promise(() => {}));

    const answer = controller.ready(response as unknown as Response);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(answer).resolves.toEqual({ status: 'unavailable' });
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
