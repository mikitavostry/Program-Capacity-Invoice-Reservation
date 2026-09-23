import { Logger } from '@nestjs/common';
import type {
  KafkaMessagePayload,
  KafkaProducer,
} from '../../../../platform/kafka/kafka-client.js';

export class DeadLetterPublisher {
  private readonly logger = new Logger(DeadLetterPublisher.name);

  constructor(
    private readonly producer: KafkaProducer,
    private readonly topic: string,
  ) {}

  async publish(
    payload: KafkaMessagePayload,
    reason: string,
    detail: readonly string[],
  ): Promise<void> {
    const { topic, partition, message } = payload;

    this.logger.error(
      `Dead-lettering ${topic}[${partition}]@${message.offset}: ${reason}${
        detail.length > 0 ? ` (${detail.join('; ')})` : ''
      }`,
    );

    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            'x-dead-letter-reason': reason,
            'x-dead-letter-detail': detail.join('; '),
            'x-original-topic': topic,
            'x-original-partition': String(partition),
            'x-original-offset': message.offset,
            'x-dead-lettered-at': new Date().toISOString(),
          },
        },
      ],
    });
  }
}
