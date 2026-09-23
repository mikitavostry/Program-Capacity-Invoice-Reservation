import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import { ProgramAlreadyExistsError, StaleTreasuryUpdateError } from '../../domain/errors.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
  type CapacityUnitOfWork,
} from '../../domain/ports/capacity-transaction-runner.js';
import { TreasuryEventAlreadyRecordedError } from '../../domain/ports/treasury-event-log.js';
import { Program } from '../../domain/program.js';
import { ProgramNotFoundError } from '../errors.js';
import { toProgramCapacityView } from '../views.js';
import {
  ApplyTreasuryUpdateCommand,
  type ApplyTreasuryUpdateResult,
  type TreasuryUpdateOutcome,
} from './apply-treasury-update.command.js';

interface Outcome {
  readonly outcome: TreasuryUpdateOutcome;
  readonly program: Program;
  readonly events: DomainEvent[];
  readonly reason: string | null;
}

/** The first message with a limit for a program id opens the program; later ones update it. */
@CommandHandler(ApplyTreasuryUpdateCommand)
export class ApplyTreasuryUpdateHandler implements ICommandHandler<ApplyTreasuryUpdateCommand> {
  private readonly logger = new Logger(ApplyTreasuryUpdateHandler.name);

  constructor(
    @Inject(CAPACITY_TRANSACTION_RUNNER) private readonly transactions: CapacityTransactionRunner,
  ) {}

  async execute(command: ApplyTreasuryUpdateCommand): Promise<ApplyTreasuryUpdateResult> {
    try {
      const outcome = await this.applyOnce(command).catch((error: unknown) => {
        // Two first messages for one program raced and the other opened it; apply this one as
        // an update. The failed insert rolled its transaction back.
        if (error instanceof ProgramAlreadyExistsError) return this.applyOnce(command);
        throw error;
      });

      return { outcome: outcome.outcome, program: toProgramCapacityView(outcome.program) };
    } catch (error) {
      if (error instanceof TreasuryEventAlreadyRecordedError) {
        this.logger.debug(`Treasury event ${command.eventId} was already applied; ignoring.`);
        return { outcome: 'DUPLICATE', program: null };
      }
      throw error;
    }
  }

  private applyOnce(command: ApplyTreasuryUpdateCommand): Promise<Outcome> {
    return this.transactions.run(async (uow) => {
      const existing = await uow.programs.lockById(command.programId);
      const outcome =
        existing === null
          ? await this.open(uow, command)
          : await this.update(uow, command, existing);

      await uow.treasuryEvents.record({
        programId: command.programId,
        eventId: command.eventId,
        kind: command.kind,
        sequence: command.sequence,
        applied: outcome.outcome !== 'STALE',
        reason: outcome.reason,
        payload: command.payload,
        occurredAt: command.occurredAt,
      });
      await uow.ledger.record(outcome.events);
      await uow.outbox.add(outcome.events);

      return outcome;
    });
  }

  private async open(
    uow: CapacityUnitOfWork,
    command: ApplyTreasuryUpdateCommand,
  ): Promise<Outcome> {
    // A status change has no limit to open a program with; it is dead-lettered.
    const creditLimit = command.creditLimit;
    if (creditLimit === null) throw new ProgramNotFoundError(command.programId);

    const program = Program.openFromTreasury(command.programId, {
      ...stateOf(command),
      creditLimit,
    });
    await uow.programs.insert(program);

    return { outcome: 'CREATED', program, events: program.pullDomainEvents(), reason: null };
  }

  private async update(
    uow: CapacityUnitOfWork,
    command: ApplyTreasuryUpdateCommand,
    program: Program,
  ): Promise<Outcome> {
    try {
      program.applyTreasuryState(stateOf(command));
    } catch (error) {
      if (!(error instanceof StaleTreasuryUpdateError)) throw error;
      return { outcome: 'STALE', program, events: [], reason: error.message };
    }

    await uow.programs.save(program);

    return { outcome: 'APPLIED', program, events: program.pullDomainEvents(), reason: null };
  }
}

function stateOf(command: ApplyTreasuryUpdateCommand) {
  return {
    creditLimit: command.creditLimit,
    sequence: command.sequence,
    status: command.status,
    at: command.occurredAt,
  };
}
