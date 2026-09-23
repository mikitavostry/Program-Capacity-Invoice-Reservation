import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../iam/decorators.js';

const logger = new Logger('HTTP');

/**
 * One line per request, with the caller. Middleware, not an interceptor: interceptors run after
 * guards and would miss the refused 401s and 403s.
 */
export function requestLogging(request: Request, response: Response, next: NextFunction): void {
  const started = performance.now();

  response.on('finish', () => {
    const elapsed = (performance.now() - started).toFixed(1);
    const caller = (request as Request & AuthenticatedRequest).principal?.subject ?? 'anonymous';
    const line = `${request.method} ${request.originalUrl} ${response.statusCode} ${elapsed}ms caller=${caller}`;

    if (response.statusCode >= 500) logger.error(line);
    else if (response.statusCode >= 400) logger.warn(line);
    else logger.log(line);
  });

  next();
}
