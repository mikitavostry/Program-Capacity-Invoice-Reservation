import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { parserFailure, sendProblem } from './problem-details.filter.js';
import { requestLogging } from './request-logging.js';

/** Largest request body accepted. The biggest legitimate body here is a few hundred bytes. */
const BODY_LIMIT = '16kb';

/**
 * Options every app instance must be created with. Nest's own body parser is switched off
 * because it turns a JSON syntax error into a bare 400 and discards the original error, which
 * leaves no way to tell a malformed body from any other bad request. `configureApp` installs
 * a parser whose failures become proper problem responses instead.
 */
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

/**
 * Everything applied to the app outside the module graph. Shared by `main.ts` and the
 * end-to-end tests, so the tests exercise the same HTTP stack that runs in production.
 */
export function configureApp(app: INestApplication): INestApplication {
  const server = app.getHttpAdapter().getInstance() as Express;
  server.disable('x-powered-by');

  app.use(requestLogging);
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(bodyParserErrors);
  app.enableShutdownHooks();

  return app;
}

/** Express error middleware: four parameters is what marks it as one. */
function bodyParserErrors(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const problem = parserFailure(error);
  if (problem === null) {
    next(error);
    return;
  }
  sendProblem(response, request, problem);
}
