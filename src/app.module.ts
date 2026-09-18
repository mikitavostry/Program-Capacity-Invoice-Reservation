import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { CapacityModule } from './contexts/capacity/capacity.module.js';
import { CAPACITY_ERROR_STATUSES } from './contexts/capacity/presentation/http/error-statuses.js';
import { IamModule } from './iam/iam.module.js';
import type { AppConfig } from './platform/config/app-config.js';
import { ConfigModule } from './platform/config/config.module.js';
import { HealthController } from './platform/health/health.controller.js';
import {
  ProblemDetailsFilter,
  SHARED_ERROR_STATUSES,
} from './platform/http/problem-details.filter.js';
import { PrismaModule } from './platform/prisma/prisma.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        PrismaModule,
        CqrsModule.forRoot(),
        IamModule,
        CapacityModule,
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: APP_FILTER,
          useFactory: () =>
            new ProblemDetailsFilter({ ...SHARED_ERROR_STATUSES, ...CAPACITY_ERROR_STATUSES }),
        },
      ],
    };
  }
}
