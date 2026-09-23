import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';

/*
 * A stand-in for the treasury system on the test run's Kafka container: it creates a private
 * pair of topics per test suite, publishes messages in treasury's wire format, and can read
 * back what the service parked in the dead-letter topic.
 */

export const TEST_BROKERS = (process.env['KAFKA_BROKERS'] || 'localhost:19092').split(',');

/**
 * The event type follows from what is given: a limit alone is a capacity change, a status alone
 * a status change, and `reconciliation` sends both as the full state. `eventType` overrides it,
 * for tests of messages treasury should never send.
 */
export interface TreasuryMessageFields {
  readonly programId: string;
  readonly creditLimit?: string;
  readonly currency?: string;
  /** A periodic reconciliation: the full state, limit (default 1000.00) and status. */
  readonly reconciliation?: boolean;
  readonly sequence?: number;
  readonly status?: 'ACTIVE' | 'SUSPENDED';
  readonly eventId?: string;
  readonly eventType?: string;
}

/** A message exactly as treasury would publish it. */
export function treasuryMessage(fields: TreasuryMessageFields): string {
  const eventType = fields.reconciliation
    ? 'program.state.reconciled'
    : fields.creditLimit === undefined && fields.status !== undefined
      ? 'program.status.changed'
      : 'program.capacity.changed';

  const program: Record<string, unknown> = { id: fields.programId };
  if (eventType !== 'program.status.changed') {
    program['creditLimit'] = {
      amount: fields.creditLimit ?? '1000.00',
      currency: fields.currency ?? 'USD',
    };
  }
  if (fields.status !== undefined) program['status'] = fields.status;

  return JSON.stringify({
    eventId: fields.eventId ?? `treasury-${randomUUID()}`,
    eventType: fields.eventType ?? eventType,
    occurredAt: new Date().toISOString(),
    sequence: fields.sequence ?? 1,
    program,
  });
}

/** Polls until `check` stops throwing, so a test waits for the feed rather than for a clock. */
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw lastError;
}

export class TreasuryTopic {
  readonly topic = `treasury.test.${randomUUID()}`;
  readonly deadLetterTopic = `${this.topic}.dead-letter`;
  /** Where the service under test publishes its own events. */
  readonly capacityEventsTopic = `${this.topic}.capacity-events`;

  readonly #kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: TEST_BROKERS,
      clientId: 'treasury-test',
      logLevel: KafkaJS.logLevel.NOTHING,
    },
  });
  #producer: ReturnType<KafkaJS.Kafka['producer']> | null = null;

  /** Creates the topics and connects the producer. */
  async start(): Promise<this> {
    const admin = this.#kafka.admin();
    try {
      await admin.connect();
    } catch (error) {
      throw new Error(`Cannot reach the test Kafka broker at ${TEST_BROKERS.join(', ')}.`, {
        cause: error,
      });
    }

    try {
      await admin.createTopics({
        topics: [
          { topic: this.topic, numPartitions: 1 },
          { topic: this.deadLetterTopic, numPartitions: 1 },
          { topic: this.capacityEventsTopic, numPartitions: 1 },
        ],
      });
    } finally {
      await admin.disconnect();
    }

    this.#producer = this.#kafka.producer();
    await this.#producer.connect();
    return this;
  }

  /** Environment that points the service's consumer at these topics, in a group of its own. */
  serviceEnv(): Record<string, string> {
    return {
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: TEST_BROKERS.join(','),
      KAFKA_TREASURY_TOPIC: this.topic,
      KAFKA_DEAD_LETTER_TOPIC: this.deadLetterTopic,
      KAFKA_CAPACITY_EVENTS_TOPIC: this.capacityEventsTopic,
      OUTBOX_POLL_INTERVAL_MS: '100',
      KAFKA_GROUP_ID: `treasury-test-${randomUUID()}`,
    };
  }

  /** Publishes raw bytes, keyed by program as treasury keys them. */
  async send(value: string, key = 'program'): Promise<void> {
    if (this.#producer === null) throw new Error('TreasuryTopic.start() was not called.');
    await this.#producer.send({ topic: this.topic, messages: [{ key, value }] });
  }

  publish(fields: TreasuryMessageFields): Promise<void> {
    return this.send(treasuryMessage(fields), fields.programId);
  }

  /** Reads the dead-letter topic from the beginning until at least `expected` have arrived. */
  readDeadLetters(expected: number): Promise<KafkaJS.Message[]> {
    return this.read(this.deadLetterTopic, expected);
  }

  /** Reads what the service published, from the beginning, until `expected` messages arrived. */
  readCapacityEvents(expected: number): Promise<KafkaJS.Message[]> {
    return this.read(this.capacityEventsTopic, expected);
  }

  private async read(topic: string, expected: number): Promise<KafkaJS.Message[]> {
    const consumer = this.#kafka.consumer({
      kafkaJS: { groupId: `dead-letter-reader-${randomUUID()}`, fromBeginning: true },
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [topic] });

    const collected: KafkaJS.Message[] = [];
    await consumer.run({
      eachMessage: async ({ message }) => {
        collected.push(message);
      },
    });

    try {
      await eventually(async () => {
        if (collected.length < expected) {
          throw new Error(`${collected.length} of ${expected} messages on ${topic} so far.`);
        }
      });
      return collected;
    } finally {
      await consumer.disconnect();
    }
  }

  async stop(): Promise<void> {
    await this.#producer?.disconnect();
    this.#producer = null;
  }
}
