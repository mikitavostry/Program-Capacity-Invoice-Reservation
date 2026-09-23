import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { parserFailure, sendProblem } from './problem-details.filter.js';
import { requestLogging } from './request-logging.js';

/** Legitimate bodies are a few hundred bytes. */
const BODY_LIMIT = '16kb';

/**
 * Nest's body parser is off: it turns malformed JSON into a bare 400. `configureApp` installs
 * one whose failures become problem responses.
 */
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

/** HTTP setup shared by `main.ts` and the e2e tests, so both run the same stack. */
export function configureApp(app: INestApplication): INestApplication {
  const server = app.getHttpAdapter().getInstance() as Express;
  server.disable('x-powered-by');

  app.use(requestLogging);
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(bodyParserErrors);
  app.enableShutdownHooks();

  return app;
}

/** Express recognises error middleware by its four parameters. */
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
