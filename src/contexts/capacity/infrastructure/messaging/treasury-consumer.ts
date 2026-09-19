import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation-error.js';
import type { KafkaMessagePayload } from '../../../../platform/kafka/kafka-client.js';
import { ProgramNotFoundError } from '../../application/errors.js';
import { CapacityBusyError } from '../../domain/ports/capacity-transaction-runner.js';
import type { DeadLetterPublisher } from './dead-letter-publisher.js';
import { TreasuryMessageError, toCommand } from './treasury-message.js';

/**
 * Applies the treasury feed to program capacity.
 *
 * Every failure is one of two kinds, and telling them apart is the whole job:
 *
 * - **Permanent** — the same bytes will fail the same way forever: not JSON, not the agreed
 *   schema, an unknown program. Retrying blocks the partition behind a message that will
 *   never pass, so it goes to the dead-letter topic and the feed moves on.
 * - **Temporary** — a locked program, a database that is down. The message is fine and will
 *   apply once the cause clears, so the error is rethrown: the offset is not committed and
 *   the message comes back. Dead-lettering these would throw away real capacity changes.
 *
 * Duplicates need no special handling here: the command is idempotent on the treasury event
 * id, and out-of-order messages are recognised by sequence (§13).
 */
export class TreasuryMessageProcessor {
  private readonly logger = new Logger(TreasuryMessageProcessor.name);

  constructor(
    private readonly commands: CommandBus,
    private readonly deadLetters: DeadLetterPublisher,
  ) {}

  async process(payload: KafkaMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const at = `${topic}[${partition}]@${message.offset}`;

    let command;
    try {
      command = toCommand(message.value);
    } catch (error) {
      if (error instanceof TreasuryMessageError) {
        await this.deadLetters.publish(payload, error.message, error.issues);
        return;
      }
      throw error;
    }

    try {
      const result = await this.commands.execute(command);
      this.logger.log(
        `Treasury event ${command.eventId} for program ${command.programId.value} at sequence ${command.sequence}: ${result.outcome} (${at})`,
      );
    } catch (error) {
      if (isPermanent(error)) {
        await this.deadLetters.publish(payload, describe(error), []);
        return;
      }

      this.logger.warn(
        `Treasury event ${command.eventId} could not be applied yet (${at}); it will be retried.`,
      );
      throw error;
    }
  }
}

/**
 * Whether retrying this message could ever produce a different answer.
 *
 * Contention and infrastructure failures are explicitly temporary. Everything unrecognised is
 * treated as temporary too: parking a message wrongly loses a capacity change, while retrying
 * one wrongly is visible and recoverable, and the dead-letter topic is still there once the
 * cause is understood.
 */
function isPermanent(error: unknown): boolean {
  if (error instanceof CapacityBusyError) return false;
  if (error instanceof InvariantViolationError) return false;
  if (error instanceof ProgramNotFoundError) return true;

  return error instanceof DomainError;
}

function describe(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
