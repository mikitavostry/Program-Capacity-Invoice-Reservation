import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { ProgramAlreadyExistsError } from '../../domain/errors.js';
import { ProgramOpened } from '../../domain/events.js';
import { ProgramId } from '../../domain/ids.js';
import { OpenProgramCommand } from './open-program.command.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const PROGRAM = ProgramId.of('program-1');

describe('OpenProgramHandler', () => {
  let f: CapacityFixture;

  beforeEach(() => {
    f = capacityFixture();
  });

  const open = (limit: Money) => f.openProgram.execute(new OpenProgramCommand(PROGRAM, limit));

  it('opens a program with its whole limit available', async () => {
    const { program, created } = await open(Money.fromDecimal('10000000.00', USD));

    expect(created).toBe(true);
    expect(program.programId).toBe('program-1');
    expect(program.availableCapacity.toDecimalString()).toBe('10000000.00');
    expect(program.status).toBe('ACTIVE');
  });

  it('announces the opening once committed', async () => {
    await open(Money.fromDecimal('1000.00', USD));

    expect(f.events.published).toHaveLength(1);
    expect(f.events.published[0]).toBeInstanceOf(ProgramOpened);
  });

  it('answers a repeated request with the existing program', async () => {
    await open(Money.fromDecimal('1000.00', USD));

    const repeat = await open(Money.fromDecimal('1000.00', USD));

    expect(repeat.created).toBe(false);
    expect(f.events.published).toHaveLength(1);
  });

  it('refuses the id when it is already taken with a different limit', async () => {
    await open(Money.fromDecimal('1000.00', USD));

    await expect(open(Money.fromDecimal('2000.00', USD))).rejects.toThrow(
      ProgramAlreadyExistsError,
    );
  });

  it('refuses the id when it is already taken in a different currency', async () => {
    await open(Money.fromDecimal('1000.00', USD));

    await expect(open(Money.fromDecimal('1000.00', EUR))).rejects.toThrow(
      ProgramAlreadyExistsError,
    );
  });
});
