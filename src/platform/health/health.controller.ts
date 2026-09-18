import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../iam/decorators.js';
import { PrismaClient } from '../prisma/prisma-client.js';

/**
 * Unauthenticated by design — orchestrators probe these without credentials — and so they
 * reveal nothing beyond up or down.
 */
@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** The process is running. Deliberately independent of the database, so a database outage
   *  makes the service unready rather than getting it restarted in a loop. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** The service can do its job: the database answers. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable' };
    }
  }
}
