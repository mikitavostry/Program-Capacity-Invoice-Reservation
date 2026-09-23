/**
 * Plays the treasury system: publishes one message to the local feed.
 *
 *   npm run treasury -- --program program-1 --limit 10000000.00 --currency USD   # opens it
 *   npm run treasury -- --program program-1 --limit 2500000.00                    # new limit
 *   npm run treasury -- --program program-1 --status SUSPENDED                    # new status
 *   npm run treasury -- --program program-1 --limit 2500000.00 --status ACTIVE --reconcile
 *   npm run treasury -- --program program-1 --malformed
 *
 * `--limit` alone sends a capacity change, `--status` alone a status change, and both with
 * `--reconcile` a periodic reconciliation (the full state). The first message with a limit for a
 * program id opens that program; later ones update it. `--malformed` sends something the schema
 * rejects, to watch it land in the dead-letter topic.
 *
 * `--sequence` defaults to the current time in seconds, so successive runs are always newer.
 * `--event-id` fixes the message id, so publishing the same message again is a duplicate.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { KafkaJS } from '@confluentinc/kafka-javascript';

if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to publish hand-made treasury messages with NODE_ENV=production.');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    program: { type: 'string', default: 'program-1' },
    limit: { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    sequence: { type: 'string' },
    reconcile: { type: 'boolean', default: false },
    status: { type: 'string' },
    'event-id': { type: 'string' },
    malformed: { type: 'boolean', default: false },
  },
});

const eventType = values.reconcile
  ? 'program.state.reconciled'
  : values.status !== undefined
    ? 'program.status.changed'
    : 'program.capacity.changed';

if (!values.malformed) {
  if (values.reconcile && (values.limit === undefined || values.status === undefined)) {
    fail('A reconciliation carries the full state: give both --limit and --status.');
  }
  if (!values.reconcile && values.limit !== undefined && values.status !== undefined) {
    fail('Send --limit and --status separately, or together with --reconcile.');
  }
  if (!values.reconcile && values.limit === undefined && values.status === undefined) {
    fail('Give --limit (a capacity change) or --status (a status change).');
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:19092').split(',');
const topic = process.env['KAFKA_TREASURY_TOPIC'] ?? 'treasury.program-capacity';

const kafka = new KafkaJS.Kafka({
  kafkaJS: { brokers, clientId: 'treasury-publisher', logLevel: KafkaJS.logLevel.NOTHING },
});

const program: Record<string, unknown> = { id: values.program };
if (values.limit !== undefined) {
  program['creditLimit'] = { amount: values.limit, currency: values.currency };
}
if (values.status !== undefined) program['status'] = values.status;

const message = values.malformed
  ? '{ "eventId": "malformed", not really json'
  : JSON.stringify({
      eventId: values['event-id'] ?? `treasury-${randomUUID()}`,
      eventType,
      occurredAt: new Date().toISOString(),
      sequence: Number(values.sequence ?? Math.floor(Date.now() / 1000)),
      program,
    });

const producer = kafka.producer();
await producer.connect();
await producer.send({ topic, messages: [{ key: values.program, value: message }] });
await producer.disconnect();

console.log(`Published to ${topic}:`);
console.log(message);
