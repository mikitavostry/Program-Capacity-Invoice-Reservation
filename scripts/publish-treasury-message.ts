/**
 * Publishes a treasury message to the local feed, to exercise it by hand.
 *
 *   npm run treasury -- --program program-1 --limit 2500000.00 --sequence 1
 *   npm run treasury -- --program program-1 --limit 2500000.00 --sequence 2 --reserved 125000.00
 *   npm run treasury -- --program program-1 --malformed
 *
 * `--reserved` sends a bulk reconciliation instead of a capacity change. `--malformed` sends
 * something the schema rejects, to watch it land in the dead-letter topic.
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
    limit: { type: 'string', default: '2500000.00' },
    currency: { type: 'string', default: 'USD' },
    sequence: { type: 'string' },
    reserved: { type: 'string' },
    malformed: { type: 'boolean', default: false },
  },
});

const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:19092').split(',');
const topic = process.env['KAFKA_TREASURY_TOPIC'] ?? 'treasury.program-capacity';
const deadLetterTopic =
  process.env['KAFKA_DEAD_LETTER_TOPIC'] ?? 'treasury.program-capacity.dead-letter';

const kafka = new KafkaJS.Kafka({
  kafkaJS: { brokers, clientId: 'treasury-publisher', logLevel: KafkaJS.logLevel.NOTHING },
});

// Created here so a first local run does not need the topics to exist already.
const admin = kafka.admin();
await admin.connect();
await admin
  .createTopics({
    topics: [
      { topic, numPartitions: 1 },
      { topic: deadLetterTopic, numPartitions: 1 },
    ],
  })
  .catch(() => undefined);
await admin.disconnect();

const program: Record<string, unknown> = {
  id: values.program,
  creditLimit: { amount: values.limit, currency: values.currency },
};
if (values.reserved !== undefined) {
  program['reservedAmount'] = { amount: values.reserved, currency: values.currency };
}

const message = values.malformed
  ? '{ "eventId": "malformed", not really json'
  : JSON.stringify({
      eventId: `treasury-${randomUUID()}`,
      eventType:
        values.reserved === undefined ? 'program.capacity.changed' : 'program.state.reconciled',
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
