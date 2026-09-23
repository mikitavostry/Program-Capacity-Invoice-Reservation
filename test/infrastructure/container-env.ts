import { inject } from 'vitest';

/*
 * Runs in every test worker before its test file is loaded: points the helpers that read the
 * environment (`testDatabaseUrl()`, `TEST_BROKERS`) at the containers `global-setup.ts` started.
 */
process.env['TEST_DATABASE_URL'] = inject('testDatabaseUrl');
process.env['KAFKA_BROKERS'] = inject('kafkaBrokers');
