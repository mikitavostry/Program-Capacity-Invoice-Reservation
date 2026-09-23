import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../platform/config/app-config.js';
import {
  assertTopicsExist,
  createKafkaClient,
  createProducer,
  PRODUCER_DELIVERY_TIMEOUT_MS,
  type KafkaProducer,
} from '../../../../platform/kafka/kafka-client.js';
import { PrismaClient } from '../../../../platform/prisma/prisma-client.js';

/** Any fixed number, the same for every instance of the service. */
const RELAY_LOCK = 7_205_431_901n;
const BATCH_SIZE = 100;
/** Outlasts the producer's delivery timeout, so a failed send rolls the batch back cleanly. */
const RELAY_TRANSACTION_TIMEOUT_MS = PRODUCER_DELIVERY_TIMEOUT_MS * 2;

/**
 * Publishes the outbox to `capacity.events`, keyed by program.
 *
 * Each tick takes the oldest unpublished events, sends them and marks them published in one
 * transaction, so an event is marked only after the broker acknowledged it; a failed send is
 * retried next tick (at-least-once, deduplicated by `eventId`). A Postgres advisory lock lets
 * one instance relay at a time, which keeps events in order. It touches no program row, so a
 * slow send holds up no reservation.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private producer: KafkaProducer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { enabled, capacityEventsTopic, outboxPollIntervalMs } = this.config.kafka;
    if (!enabled) {
      this.logger.log('The outbox relay is off with the treasury feed; events stay in the outbox.');
      return;
    }

    const kafka = createKafkaClient(this.config.kafka);
    await assertTopicsExist(kafka, [capacityEventsTopic]);

    this.producer = createProducer(kafka);
    await this.producer.connect();

    this.timer = setInterval(() => {
      this.running ??= this.relay().finally(() => (this.running = null));
    }, outboxPollIntervalMs);

    this.logger.log(`Publishing the outbox to ${capacityEventsTopic}.`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight batch finish, so it is not sent twice.
    await this.running;

    try {
      await this.producer?.disconnect();
    } catch (error) {
      this.logger.warn(`The outbox relay's producer did not disconnect cleanly: ${String(error)}`);
    }
    this.producer = null;
  }

  async relay(): Promise<void> {
    try {
      while ((await this.publishBatch()) === BATCH_SIZE) {}
    } catch (error) {
      this.logger.warn(`The outbox relay could not publish; it will try again: ${String(error)}`);
    }
  }

  private publishBatch(): Promise<number> {
    const producer = this.producer;
    if (producer === null) return Promise.resolve(0);

    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${RELAY_LOCK}) AS acquired`;
        if (lock?.acquired !== true) return 0;

        const batch = await tx.outboxEvent.findMany({
          where: { publishedAt: null },
          orderBy: { position: 'asc' },
          take: BATCH_SIZE,
        });
        if (batch.length === 0) return 0;

        await producer.send({
          topic: this.config.kafka.capacityEventsTopic,
          messages: batch.map((event) => ({
            key: event.programId,
            value: JSON.stringify(event.payload),
            headers: { 'event-type': event.eventType, 'event-id': event.id },
          })),
        });

        await tx.outboxEvent.updateMany({
          where: { id: { in: batch.map((event) => event.id) } },
          data: { publishedAt: new Date() },
        });

        return batch.length;
      },
      { timeout: RELAY_TRANSACTION_TIMEOUT_MS },
    );
  }
}
