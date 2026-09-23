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
  assertTopicsExist,
  createKafkaClient,
  createProducer,
  type KafkaConsumer,
  type KafkaProducer,
} from '../../../../platform/kafka/kafka-client.js';
import { DeadLetterPublisher } from './dead-letter-publisher.js';
import { TreasuryMessageProcessor } from './treasury-message-processor.js';

/**
 * Consumes the treasury topic, the only way programs are opened and their limits changed.
 * With `KAFKA_ENABLED=false` the HTTP API still runs, but no program can appear.
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
    await assertTopicsExist(kafka, [treasuryTopic, deadLetterTopic]);

    this.producer = createProducer(kafka);
    await this.producer.connect();

    const processor = new TreasuryMessageProcessor(
      this.commands,
      new DeadLetterPublisher(this.producer, deadLetterTopic),
    );

    this.consumer = kafka.consumer({
      kafkaJS: {
        groupId,
        // Applies only when the group has no committed offset yet.
        fromBeginning: true,
        allowAutoTopicCreation: false,
      },
      // Notices added partitions within 30 s instead of librdkafka's default 5 min.
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
    // Consumer first: an in-flight message may still need the producer for a dead letter.
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
