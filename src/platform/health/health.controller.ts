import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../iam/decorators.js';
import { PrismaClient } from '../prisma/prisma-client.js';

/** Unauthenticated for orchestrators, so they reveal nothing beyond up or down. */
@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** Independent of the database, so an outage makes the service unready, not restarted. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** The database answers. Kafka is left out on purpose: see docs/architecture.md §3.9. */
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
