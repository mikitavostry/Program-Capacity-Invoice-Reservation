import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class RequestValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super('The request is not valid.');
    this.name = 'RequestValidationError';
  }
}

export class ZodPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.output<Schema>> {
  constructor(
    private readonly schema: Schema,
    private readonly source: 'body' | 'query' | 'path',
  ) {}

  transform(value: unknown): z.output<Schema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: [this.source, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
}
