import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupApiDocs } from './api-docs.js';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './platform/config/app-config.js';
import { APP_OPTIONS, configureApp } from './platform/http/configure-app.js';

async function bootstrap(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const config = loadConfig();
  const app = configureApp(await NestFactory.create(AppModule.register(config), APP_OPTIONS));
  setupApiDocs(app);

  await app.listen(config.port);
  new Logger('Bootstrap').log(`Listening on port ${config.port} (${config.environment})`);
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
