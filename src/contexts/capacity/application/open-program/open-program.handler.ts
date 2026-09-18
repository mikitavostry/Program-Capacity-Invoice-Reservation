import { Inject } from '@nestjs/common';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { CLOCK, type Clock } from '../../../../shared/application/clock.js';
import { ProgramAlreadyExistsError } from '../../domain/errors.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
} from '../../domain/ports/capacity-transaction-runner.js';
import { Program } from '../../domain/program.js';
import { CAPACITY_READ_MODEL, type CapacityReadModel } from '../ports/capacity-read-model.js';
import { toProgramCapacityView } from '../views.js';
import { OpenProgramCommand, type OpenProgramResult } from './open-program.command.js';

@CommandHandler(OpenProgramCommand)
export class OpenProgramHandler implements ICommandHandler<OpenProgramCommand> {
  constructor(
    @Inject(CAPACITY_TRANSACTION_RUNNER) private readonly transactions: CapacityTransactionRunner,
    @Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  async execute(command: OpenProgramCommand): Promise<OpenProgramResult> {
    const program = Program.open({
      id: command.programId,
      creditLimit: command.creditLimit,
      openedAt: this.clock.now(),
    });

    try {
      await this.transactions.run(async (uow) => {
        await uow.programs.insert(program);
        await uow.ledger.record(program.domainEvents);
      });
    } catch (error) {
      if (error instanceof ProgramAlreadyExistsError) return this.replayOrRefuse(command, error);
      throw error;
    }

    this.events.publishAll(program.pullDomainEvents());

    return { program: toProgramCapacityView(program), created: true };
  }

  /**
   * Insert first and look only on conflict: checking beforehand would still race another
   * request for the same id, and the unique key settles that race whichever way it falls.
   */
  private async replayOrRefuse(
    command: OpenProgramCommand,
    conflict: ProgramAlreadyExistsError,
  ): Promise<OpenProgramResult> {
    const existing = await this.readModel.getProgramCapacity(command.programId);

    if (existing !== null && existing.creditLimit.equals(command.creditLimit)) {
      return { program: existing, created: false };
    }

    throw conflict;
  }
}
