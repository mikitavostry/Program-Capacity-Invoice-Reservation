import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { AppConfig } from '../config/app-config.js';

export type KafkaConsumer = ReturnType<KafkaJS.Kafka['consumer']>;
export type KafkaProducer = ReturnType<KafkaJS.Kafka['producer']>;
export type KafkaMessagePayload = KafkaJS.EachMessagePayload;

export const KAFKA_CLIENT = Symbol('KafkaClient');

/**
 * Confluent's client is the maintained one — kafkajs has not been published since 2023 — and
 * it offers a KafkaJS-shaped API, which is what the `kafkaJS` blocks below select.
 */
export function createKafkaClient(config: AppConfig['kafka']): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      clientId: config.clientId,
      brokers: [...config.brokers],
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
}
