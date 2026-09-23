import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation-error.js';
import type { KafkaMessagePayload } from '../../../../platform/kafka/kafka-client.js';
import { CapacityBusyError } from '../../domain/ports/capacity-transaction-runner.js';
import type { DeadLetterPublisher } from './dead-letter-publisher.js';
import { TreasuryMessageError, toCommand } from './treasury-message.js';

export interface RetryPolicy {
  readonly initialDelayMs: number;
  /** Well under `max.poll.interval.ms` (five minutes), past which the group evicts us. */
  readonly maxDelayMs: number;
  /** From this many consecutive failures on, each is logged as an error to alert on. */
  readonly alertAfterAttempts: number;
  readonly sleep: (ms: number) => Promise<unknown>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  alertAfterAttempts: 10,
  sleep,
};

/**
 * Applies one treasury message, sorting failures into two kinds:
 *
 * - **Permanent** (bad JSON, wrong schema, a value the rules reject): the same bytes will
 *   always fail, so the message goes to the dead-letter topic and the feed moves on.
 * - **Temporary** (a locked program, the database down): rethrown so the offset is not
 *   committed and the message is redelivered. The client redelivers at once, so the rethrow
 *   waits first, backing off exponentially. Nothing behind the message is processed meanwhile,
 *   which per-program order requires.
 *
 * Duplicates and reordering are handled by the command (event id and sequence).
 */
export class TreasuryMessageProcessor {
  private readonly logger = new Logger(TreasuryMessageProcessor.name);
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly commands: CommandBus,
    private readonly deadLetters: DeadLetterPublisher,
    private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async process(payload: KafkaMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const at = `${topic}[${partition}]@${message.offset}`;
    const partitionKey = `${topic}[${partition}]`;

    try {
      const command = toCommand(message.value);
      const result = await this.commands.execute(command);
      this.logger.log(
        `Treasury event ${command.eventId} for program ${command.programId.value} at sequence ${command.sequence}: ${result.outcome} (${at})`,
      );
      this.failures.delete(partitionKey);
    } catch (error) {
      if (error instanceof TreasuryMessageError) {
        await this.deadLetters.publish(payload, error.message, error.issues);
        this.failures.delete(partitionKey);
        return;
      }
      if (isPermanent(error)) {
        await this.deadLetters.publish(payload, describe(error), []);
        this.failures.delete(partitionKey);
        return;
      }

      const attempt = (this.failures.get(partitionKey) ?? 0) + 1;
      this.failures.set(partitionKey, attempt);
      const delayMs = Math.min(
        this.retry.initialDelayMs * 2 ** (attempt - 1),
        this.retry.maxDelayMs,
      );

      const report = `Treasury message ${at} could not be applied yet (attempt ${attempt}): ${describe(error)}. Retrying in ${delayMs} ms.`;
      if (attempt >= this.retry.alertAfterAttempts) {
        this.logger.error(`${report} The partition is blocked behind it.`);
      } else {
        this.logger.warn(report);
      }

      await this.retry.sleep(delayMs);
      throw error;
    }
  }
}

/**
 * Anything unrecognised counts as temporary: dead-lettering a good message wrongly loses a
 * capacity change, while retrying a bad one is visible in the logs and recoverable.
 */
function isPermanent(error: unknown): boolean {
  if (error instanceof CapacityBusyError) return false;
  if (error instanceof InvariantViolationError) return false;

  return error instanceof DomainError;
}

function describe(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
