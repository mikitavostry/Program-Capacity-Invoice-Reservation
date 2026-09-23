import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config.js';
import { PrismaClient } from '../../platform/prisma/prisma-client.js';
import { CLOCK, systemClock } from '../../shared/application/clock.js';
import { ApplyTreasuryUpdateHandler } from './application/apply-treasury-update/apply-treasury-update.handler.js';
import { GetProgramCapacityHandler } from './application/get-program-capacity/get-program-capacity.handler.js';
import { ListReservationsHandler } from './application/list-reservations/list-reservations.handler.js';
import { CAPACITY_READ_MODEL } from './application/ports/capacity-read-model.js';
import { RecordRepaymentHandler } from './application/record-repayment/record-repayment.handler.js';
import { ReserveCapacityHandler } from './application/reserve-capacity/reserve-capacity.handler.js';
import { CAPACITY_TRANSACTION_RUNNER } from './domain/ports/capacity-transaction-runner.js';
import { EXCHANGE_RATE_PROVIDER } from './domain/ports/exchange-rate-provider.js';
import { StaticExchangeRateProvider } from './infrastructure/fx/static-exchange-rate-provider.js';
import { OutboxRelay } from './infrastructure/messaging/outbox-relay.js';
import { TreasuryFeed } from './infrastructure/messaging/treasury-feed.js';
import { PrismaCapacityReadModel } from './infrastructure/persistence/prisma/prisma-capacity-read-model.js';
import { PrismaCapacityTransactionRunner } from './infrastructure/persistence/prisma/prisma-capacity-transaction-runner.js';
import { ProgramsController } from './presentation/http/programs.controller.js';
import { ReservationsController } from './presentation/http/reservations.controller.js';

@Module({
  controllers: [ProgramsController, ReservationsController],
  providers: [
    ReserveCapacityHandler,
    RecordRepaymentHandler,
    GetProgramCapacityHandler,
    ListReservationsHandler,
    ApplyTreasuryUpdateHandler,
    TreasuryFeed,
    OutboxRelay,
    {
      provide: CAPACITY_TRANSACTION_RUNNER,
      inject: [PrismaClient, APP_CONFIG],
      useFactory: (prisma: PrismaClient, config: AppConfig) =>
        new PrismaCapacityTransactionRunner(prisma, {
          lockTimeoutMs: config.database.lockTimeoutMs,
          statementTimeoutMs: config.database.statementTimeoutMs,
          transactionTimeoutMs: config.database.transactionTimeoutMs,
          maxWaitMs: config.database.maxWaitMs,
        }),
    },
    {
      provide: CAPACITY_READ_MODEL,
      inject: [PrismaClient],
      useFactory: (prisma: PrismaClient) => new PrismaCapacityReadModel(prisma),
    },
    {
      provide: EXCHANGE_RATE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new StaticExchangeRateProvider(config.fx),
    },
    { provide: CLOCK, useValue: systemClock },
  ],
})
export class CapacityModule {}
