import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { APP_CONFIG, type AppConfig } from '../../../../platform/config/app-config.js';
import {
  createKafkaClient,
  type KafkaConsumer,
  type KafkaProducer,
} from '../../../../platform/kafka/kafka-client.js';
import { DeadLetterPublisher } from './dead-letter-publisher.js';
import { TreasuryMessageProcessor } from './treasury-consumer.js';

/**
 * Owns the connection to the treasury feed: subscribes on startup, stops cleanly on shutdown.
 *
 * Switched off by configuration (`KAFKA_ENABLED`) by default, so the HTTP service runs with
 * no broker at all — locally, in tests, and in any deployment that does not consume the feed.
 */
@Injectable()
export class TreasuryFeed implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryFeed.name);
  private consumer: KafkaConsumer | null = null;
  private producer: KafkaProducer | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandBus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async start(): Promise<void> {
    const { enabled, brokers, groupId, treasuryTopic, deadLetterTopic } = this.config.kafka;
    if (!enabled) {
      this.logger.log('Treasury feed is disabled; set KAFKA_ENABLED=true to consume it.');
      return;
    }

    const kafka = createKafkaClient(this.config.kafka);

    this.producer = kafka.producer();
    await this.producer.connect();

    const processor = new TreasuryMessageProcessor(
      this.commands,
      new DeadLetterPublisher(this.producer, deadLetterTopic),
    );

    this.consumer = kafka.consumer({
      kafkaJS: {
        groupId,
        // From the beginning only when this group has no committed offsets: on restart it
        // resumes where it left off, and at-least-once delivery is safe because applying a
        // treasury event twice is a no-op.
        fromBeginning: true,
      },
      // Topics are expected to exist before the service starts. When one does not, the
      // default five-minute metadata refresh leaves the feed looking dead for minutes after
      // it appears; thirty seconds bounds that without polling the broker hard.
      'topic.metadata.refresh.interval.ms': 30_000,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [treasuryTopic] });
    await this.consumer.run({ eachMessage: (payload) => processor.process(payload) });

    this.logger.log(
      `Consuming ${treasuryTopic} as "${groupId}" from ${brokers.join(', ')}; dead letters go to ${deadLetterTopic}.`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    // Disconnecting the consumer first lets an in-flight message finish and commit before the
    // producer it may still need for a dead letter goes away.
    await this.disconnect('consumer', this.consumer);
    this.consumer = null;
    await this.disconnect('producer', this.producer);
    this.producer = null;
  }

  private async disconnect(
    what: string,
    client: { disconnect(): Promise<void> } | null,
  ): Promise<void> {
    if (client === null) return;

    try {
      await client.disconnect();
    } catch (error) {
      // Shutdown must not fail because a broker went away first.
      this.logger.warn(`The treasury feed's ${what} did not disconnect cleanly: ${String(error)}`);
    }
  }
}
