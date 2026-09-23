import type { CommandBus } from '@nestjs/cqrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaMessagePayload } from '../../../../../platform/kafka/kafka-client.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import {
  InsufficientCapacityError,
  TreasuryCurrencyMismatchError,
} from '../../../domain/errors.js';
import { ProgramId } from '../../../domain/ids.js';
import { CapacityBusyError } from '../../../domain/ports/capacity-transaction-runner.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { InvalidAmountError, Money } from '../../../../../shared/money/money.js';
import type { DeadLetterPublisher } from '../dead-letter-publisher.js';
import { type RetryPolicy, TreasuryMessageProcessor } from '../treasury-message-processor.js';

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
  let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<unknown>>>;
  let processor: TreasuryMessageProcessor;

  beforeEach(() => {
    execute = vi.fn().mockResolvedValue({ outcome: 'APPLIED', program: null });
    publish = vi.fn().mockResolvedValue(undefined);
    sleep = vi.fn<(ms: number) => Promise<unknown>>().mockResolvedValue(undefined);
    const retry: RetryPolicy = {
      initialDelayMs: 100,
      maxDelayMs: 1000,
      alertAfterAttempts: 10,
      sleep,
    };
    processor = new TreasuryMessageProcessor(
      { execute } as unknown as CommandBus,
      { publish } as unknown as DeadLetterPublisher,
      retry,
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

    it('parks one whose credit limit the rules reject', async () => {
      execute.mockRejectedValue(new InvalidAmountError('A credit limit must be positive.'));

      await processor.process(payload(valid));

      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('INVALID_AMOUNT'),
        [],
      );
    });

    it('parks one that states an amount in another currency than the program’s', async () => {
      execute.mockRejectedValue(
        new TreasuryCurrencyMismatchError(ProgramId.of('program-1'), Currency.of('EUR'), USD),
      );

      await processor.process(payload(valid));

      expect(publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('TREASURY_CURRENCY_MISMATCH'),
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

    it('waits before each retry, doubling the wait up to a ceiling', async () => {
      execute.mockRejectedValue(new Error('connection refused'));

      for (let attempt = 0; attempt < 6; attempt++) {
        await expect(processor.process(payload(valid))).rejects.toThrow();
      }

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 800, 1000, 1000]);
    });

    it('starts again from the shortest wait once the partition moves on', async () => {
      execute.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
      await expect(processor.process(payload(valid))).rejects.toThrow();
      await expect(processor.process(payload(valid))).rejects.toThrow();
      await processor.process(payload(valid));

      execute.mockRejectedValueOnce(new Error('down again'));
      await expect(processor.process(payload(valid))).rejects.toThrow();

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 100]);
    });

    it('retries with a backoff when the dead-letter topic cannot be reached', async () => {
      publish.mockRejectedValue(new Error('broker unreachable'));

      await expect(processor.process(payload('{ not json'))).rejects.toThrow('broker unreachable');
      await expect(processor.process(payload('{ not json'))).rejects.toThrow('broker unreachable');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    });

    it('does not wait when a message is parked', async () => {
      await processor.process(payload('{ not json'));

      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
