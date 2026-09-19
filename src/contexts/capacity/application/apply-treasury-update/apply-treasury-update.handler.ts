import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import { StaleTreasuryUpdateError } from '../../domain/errors.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
} from '../../domain/ports/capacity-transaction-runner.js';
import { TreasuryEventAlreadyRecordedError } from '../../domain/ports/treasury-event-log.js';
import { ProgramNotFoundError } from '../errors.js';
import { toProgramCapacityView } from '../views.js';
import {
  ApplyTreasuryUpdateCommand,
  type ApplyTreasuryUpdateResult,
  type TreasuryUpdateOutcome,
} from './apply-treasury-update.command.js';

@CommandHandler(ApplyTreasuryUpdateCommand)
export class ApplyTreasuryUpdateHandler implements ICommandHandler<ApplyTreasuryUpdateCommand> {
  private readonly logger = new Logger(ApplyTreasuryUpdateHandler.name);

  constructor(
    @Inject(CAPACITY_TRANSACTION_RUNNER) private readonly transactions: CapacityTransactionRunner,
    private readonly events: EventBus,
  ) {}

  async execute(command: ApplyTreasuryUpdateCommand): Promise<ApplyTreasuryUpdateResult> {
    try {
      const outcome = await this.transactions.run(async (uow) => {
        const program = await uow.programs.lockById(command.programId);
        if (program === null) throw new ProgramNotFoundError(command.programId);

        // Decided first, recorded second: the audit row says what this message did, and both
        // commit together or neither does.
        let applied: TreasuryUpdateOutcome = 'APPLIED';
        let reason: string | null = null;

        try {
          program.applyTreasuryState({
            creditLimit: command.creditLimit,
            reportedReservedAmount: command.reportedReservedAmount,
            sequence: command.sequence,
            at: command.occurredAt,
          });
        } catch (error) {
          if (!(error instanceof StaleTreasuryUpdateError)) throw error;
          applied = 'STALE';
          reason = error.message;
        }

        await uow.treasuryEvents.record({
          programId: command.programId,
          eventId: command.eventId,
          kind: command.kind,
          sequence: command.sequence,
          applied: applied === 'APPLIED',
          reason,
          payload: command.payload,
          occurredAt: command.occurredAt,
        });

        const events: DomainEvent[] = [];
        if (applied === 'APPLIED') {
          await uow.programs.save(program);
          events.push(...program.pullDomainEvents());
          await uow.ledger.record(events);
        }

        return { outcome: applied, program: toProgramCapacityView(program), events };
      });

      this.events.publishAll(outcome.events);

      return { outcome: outcome.outcome, program: outcome.program };
    } catch (error) {
      // Recorded before, so its effect is already in place: the transaction rolled back and
      // there is nothing left to do. Kafka redelivering is ordinary, not a fault.
      if (error instanceof TreasuryEventAlreadyRecordedError) {
        this.logger.debug(`Treasury event ${command.eventId} was already applied; ignoring.`);
        return { outcome: 'DUPLICATE', program: null };
      }
      throw error;
    }
  }
}
