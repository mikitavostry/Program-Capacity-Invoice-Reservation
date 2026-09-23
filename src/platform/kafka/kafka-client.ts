import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { AppConfig } from '../config/app-config.js';

export type KafkaConsumer = ReturnType<KafkaJS.Kafka['consumer']>;
export type KafkaProducer = ReturnType<KafkaJS.Kafka['producer']>;
export type KafkaMessagePayload = KafkaJS.EachMessagePayload;

/**
 * How long `send` keeps retrying before it fails (librdkafka defaults to five minutes). The
 * outbox relay holds a transaction open around `send`, so it must fail well before that.
 */
export const PRODUCER_DELIVERY_TIMEOUT_MS = 15_000;

/** Confluent's client (kafkajs is unmaintained), through its KafkaJS-compatible API. */
export function createKafkaClient(config: AppConfig['kafka']): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      clientId: config.clientId,
      brokers: [...config.brokers],
      ssl: config.ssl.enabled,
      ...(config.sasl === undefined ? {} : { sasl: { ...config.sasl } }),
      logLevel: KafkaJS.logLevel.WARN,
    },
    ...(config.ssl.caLocation === undefined ? {} : { 'ssl.ca.location': config.ssl.caLocation }),
  });
}

/**
 * Every producer is idempotent (implying `acks=all`), so a retry is neither duplicated nor
 * reordered, and never creates a topic, so a misspelt one fails instead of appearing.
 */
export function createProducer(kafka: KafkaJS.Kafka): KafkaProducer {
  return kafka.producer({
    kafkaJS: { idempotent: true, allowAutoTopicCreation: false },
    'message.timeout.ms': PRODUCER_DELIVERY_TIMEOUT_MS,
  });
}

export class MissingTopicsError extends Error {
  constructor(readonly topics: readonly string[]) {
    super(
      `Kafka topic${topics.length > 1 ? 's' : ''} ${topics.join(', ')} ` +
        `${topics.length > 1 ? 'do' : 'does'} not exist. Topics are provisioned before the ` +
        'service starts (docker/redpanda/create-topics.sh locally); it never creates them.',
    );
    this.name = 'MissingTopicsError';
  }
}

export async function assertTopicsExist(
  kafka: KafkaJS.Kafka,
  topics: readonly string[],
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((topic) => !existing.has(topic));
    if (missing.length > 0) throw new MissingTopicsError(missing);
  } finally {
    await admin.disconnect();
  }
}
