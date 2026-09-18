import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { createPrismaClient, PrismaClient } from './prisma-client.js';

/** Closes the pool on shutdown so in-flight transactions finish and connections are returned. */
@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PrismaClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPrismaClient({
          connectionString: config.database.url,
          poolSize: config.database.poolSize,
        }),
    },
    PrismaLifecycle,
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
