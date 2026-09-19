import type { CommandBus } from '@nestjs/cqrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaMessagePayload } from '../../../../platform/kafka/kafka-client.js';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation-error.js';
import { ProgramNotFoundError } from '../../application/errors.js';
import { InsufficientCapacityError } from '../../domain/errors.js';
import { ProgramId } from '../../domain/ids.js';
import { CapacityBusyError } from '../../domain/ports/capacity-transaction-runner.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import type { DeadLetterPublisher } from './dead-letter-publisher.js';
import { TreasuryMessageProcessor } from './treasury-consumer.js';

const USD = Currency.of('USD');

function payload(body: unknown): KafkaMessagePayload {
  return {
    topic: 'treasury.program-capacity',
    partition: 0,
    message: {
      offset: '42',
      key: Buffer.from('program-1'),
      value:
        body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      headers: {},
      timestamp: '0',
      attributes: 0,
    },
  } as unknown as KafkaMessagePayload;
}

const valid = {
  eventId: 'treasury-event-1',
  eventType: 'program.capacity.changed',
  occurredAt: '2026-09-20T08:00:00.000Z',
  sequence: 7,
  program: { id: 'program-1', creditLimit: { amount: '2500000.00', currency: 'USD' } },
};

describe('TreasuryMessageProcessor', () => {
  let execute: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let processor: TreasuryMessageProcessor;

  beforeEach(() => {
    execute = vi.fn().mockResolvedValue({ outcome: 'APPLIED', program: null });
    publish = vi.fn().mockResolvedValue(undefined);
    processor = new TreasuryMessageProcessor(
      { execute } as unknown as CommandBus,
      { publish } as unknown as DeadLetterPublisher,
    );
  });

  it('applies a well-formed message', async () => {
    await processor.process(payload(valid));

    expect(execute).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  describe('messages that can never succeed', () => {
    it('parks one that is not valid JSON, rather than blocking the partition', async () => {
      await processor.process(payload('{ not json'));

      expect(publish).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    });

    it('parks one for a program that does not exist', async () => {
      execute.mockRejectedValue(new ProgramNotFoundError(ProgramId.of('program-1')));

      await processor.process(payload(valid));

      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('PROGRAM_NOT_FOUND'),
        [],
      );
    });

    it('parks one the rules reject outright', async () => {
      execute.mockRejectedValue(
        new InsufficientCapacityError(
          ProgramId.of('program-1'),
          Money.fromDecimal('10.00', USD),
          Money.fromDecimal('1.00', USD),
        ),
      );

      await processor.process(payload(valid));

      expect(publish).toHaveBeenCalledOnce();
    });
  });

  describe('failures that may clear', () => {
    it.each([
      ['a program held by another writer', new CapacityBusyError()],
      ['a database that is unreachable', new Error('connection refused')],
      [
        'state that should be impossible, which may be a bug worth seeing again',
        new InvariantViolationError('counter drifted'),
      ],
    ])('rethrows %s so the message is retried, not lost', async (_, error) => {
      execute.mockRejectedValue(error);

      await expect(processor.process(payload(valid))).rejects.toThrow(error);
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
