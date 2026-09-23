import type {
  CapacityReadModel,
  ReservationListRequest,
} from '../../src/contexts/capacity/application/ports/capacity-read-model.js';
import {
  toProgramCapacityView,
  toReservationView,
  type ProgramCapacityView,
  type ReservationView,
} from '../../src/contexts/capacity/application/views.js';
import { ProgramAlreadyExistsError } from '../../src/contexts/capacity/domain/errors.js';
import {
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
  ProgramStatusChanged,
} from '../../src/contexts/capacity/domain/events.js';
import type {
  InvoiceId,
  ProgramId,
  RepaymentId,
  ReservationId,
  ReservationKey,
} from '../../src/contexts/capacity/domain/ids.js';
import type {
  CapacityLedger,
  RecordedRepayment,
} from '../../src/contexts/capacity/domain/ports/capacity-ledger.js';
import type {
  CapacityTransactionRunner,
  CapacityUnitOfWork,
} from '../../src/contexts/capacity/domain/ports/capacity-transaction-runner.js';
import type { ProgramRepository } from '../../src/contexts/capacity/domain/ports/program-repository.js';
import type { ReservationRepository } from '../../src/contexts/capacity/domain/ports/reservation-repository.js';
import {
  TreasuryEventAlreadyRecordedError,
  type TreasuryEventLog,
  type TreasuryEventRecord,
} from '../../src/contexts/capacity/domain/ports/treasury-event-log.js';
import { Program, type ProgramSnapshot } from '../../src/contexts/capacity/domain/program.js';
import {
  Reservation,
  type ReservationSnapshot,
} from '../../src/contexts/capacity/domain/reservation.js';
import type { Clock } from '../../src/shared/application/clock.js';
import type { DomainEvent } from '../../src/shared/domain/domain-event.js';
import { InvariantViolationError } from '../../src/shared/domain/invariant-violation-error.js';

type Movement = CapacityReserved | CapacityReleased;

/**
 * In-memory persistence ports for handler tests. State is stored as snapshots, so an unsaved
 * change is lost as in Postgres; transactions roll back on throw and run one at a time.
 */
export class InMemoryCapacity {
  readonly programs = new Map<string, ProgramSnapshot>();
  readonly reservations = new Map<string, ReservationSnapshot>();
  readonly movements: Movement[] = [];
  readonly treasuryEvents: TreasuryEventRecord[] = [];
  /** The domain events written to the outbox. */
  readonly outbox: DomainEvent[] = [];

  /** How many transactions are open right now — lets a test prove nothing slow runs in one. */
  openTransactions = 0;
  /** How many transactions have committed. */
  commits = 0;

  readonly transactions: CapacityTransactionRunner = new InMemoryTransactionRunner(this);
  readonly readModel: CapacityReadModel = new InMemoryReadModel(this);

  program(id: ProgramId): Program {
    const snapshot = this.programs.get(id.value);
    if (snapshot === undefined) throw new Error(`No program ${id.value}`);
    return Program.rehydrate(snapshot);
  }

  reservation(id: string): Reservation {
    const snapshot = this.reservations.get(id);
    if (snapshot === undefined) throw new Error(`No reservation ${id}`);
    return Reservation.rehydrate(snapshot);
  }
}

class InMemoryTransactionRunner implements CapacityTransactionRunner {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: InMemoryCapacity) {}

  run<T>(work: (unitOfWork: CapacityUnitOfWork) => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => this.runNow(work));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  private async runNow<T>(work: (unitOfWork: CapacityUnitOfWork) => Promise<T>): Promise<T> {
    const { store } = this;
    const before = {
      programs: new Map(store.programs),
      reservations: new Map(store.reservations),
      movements: [...store.movements],
      treasuryEvents: [...store.treasuryEvents],
      outbox: [...store.outbox],
    };

    store.openTransactions += 1;
    try {
      const result = await work({
        programs: new InMemoryProgramRepository(store),
        reservations: new InMemoryReservationRepository(store),
        ledger: new InMemoryLedger(store),
        treasuryEvents: new InMemoryTreasuryEventLog(store),
        outbox: { add: async (events) => void store.outbox.push(...events) },
      });
      store.commits += 1;
      return result;
    } catch (error) {
      replace(store.programs, before.programs);
      replace(store.reservations, before.reservations);
      store.movements.splice(0, store.movements.length, ...before.movements);
      store.treasuryEvents.splice(0, store.treasuryEvents.length, ...before.treasuryEvents);
      store.outbox.splice(0, store.outbox.length, ...before.outbox);
      throw error;
    } finally {
      store.openTransactions -= 1;
    }
  }
}

class InMemoryProgramRepository implements ProgramRepository {
  constructor(private readonly store: InMemoryCapacity) {}

  async lockById(id: ProgramId): Promise<Program | null> {
    const snapshot = this.store.programs.get(id.value);
    return snapshot === undefined ? null : Program.rehydrate(snapshot);
  }

  async insert(program: Program): Promise<void> {
    if (this.store.programs.has(program.id.value)) throw new ProgramAlreadyExistsError(program.id);
    this.store.programs.set(program.id.value, program.toSnapshot());
  }

  async save(program: Program): Promise<void> {
    const stored = this.store.programs.get(program.id.value);
    if (stored === undefined || stored.version !== program.version) {
      throw new InvariantViolationError(`Program ${program.id.value} changed while locked.`);
    }
    this.store.programs.set(program.id.value, {
      ...program.toSnapshot(),
      version: program.version + 1,
    });
  }
}

class InMemoryReservationRepository implements ReservationRepository {
  constructor(private readonly store: InMemoryCapacity) {}

  async findById(id: ReservationId): Promise<Reservation | null> {
    const snapshot = this.store.reservations.get(id.value);
    return snapshot === undefined ? null : Reservation.rehydrate(snapshot);
  }

  async findActiveByInvoice(
    programId: ProgramId,
    invoiceId: InvoiceId,
  ): Promise<Reservation | null> {
    const snapshot = this.activeFor(programId, invoiceId);
    return snapshot === undefined ? null : Reservation.rehydrate(snapshot);
  }

  async findByKey(
    programId: ProgramId,
    invoiceId: InvoiceId,
    key: ReservationKey,
  ): Promise<Reservation | null> {
    const snapshot = this.forInvoice(programId, invoiceId).find(
      (r) => r.reservationKey !== null && r.reservationKey.equals(key),
    );
    return snapshot === undefined ? null : Reservation.rehydrate(snapshot);
  }

  async hasReleasedForInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<boolean> {
    return this.forInvoice(programId, invoiceId).some((r) => r.status === 'RELEASED');
  }

  async insert(reservation: Reservation): Promise<void> {
    // Mirrors the partial unique index on active reservations.
    if (this.activeFor(reservation.programId, reservation.invoiceId) !== undefined) {
      throw new Error('Unique constraint: reservations_one_active_per_invoice');
    }
    // Mirrors the unique index on the reservation key.
    const key = reservation.reservationKey;
    if (
      key !== null &&
      this.forInvoice(reservation.programId, reservation.invoiceId).some(
        (r) => r.reservationKey !== null && r.reservationKey.equals(key),
      )
    ) {
      throw new Error('Unique constraint: reservations_program_id_invoice_id_reservation_key_key');
    }
    this.store.reservations.set(reservation.id.value, reservation.toSnapshot());
  }

  async save(reservation: Reservation): Promise<void> {
    this.store.reservations.set(reservation.id.value, reservation.toSnapshot());
  }

  private activeFor(programId: ProgramId, invoiceId: InvoiceId): ReservationSnapshot | undefined {
    return this.forInvoice(programId, invoiceId).find((r) => r.status === 'ACTIVE');
  }

  private forInvoice(programId: ProgramId, invoiceId: InvoiceId): ReservationSnapshot[] {
    return [...this.store.reservations.values()].filter(
      (r) => r.programId.equals(programId) && r.invoiceId.equals(invoiceId),
    );
  }
}

class InMemoryLedger implements CapacityLedger {
  constructor(private readonly store: InMemoryCapacity) {}

  async record(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (
        event instanceof ProgramOpened ||
        event instanceof CreditLimitChanged ||
        event instanceof ProgramStatusChanged
      ) {
        continue;
      }
      if (!(event instanceof CapacityReserved) && !(event instanceof CapacityReleased)) {
        throw new InvariantViolationError(`The ledger cannot record ${event.eventName}.`);
      }
      if (
        event instanceof CapacityReleased &&
        this.released(event.aggregateId, event.repaymentId)
      ) {
        throw new Error('Unique constraint: capacity_movements_program_id_repayment_id_key');
      }
      this.store.movements.push(event);
    }
  }

  async findRepayment(
    programId: ProgramId,
    repaymentId: RepaymentId,
  ): Promise<RecordedRepayment | null> {
    const movement = this.released(programId.value, repaymentId);
    if (movement === undefined) return null;

    return {
      reservationId: movement.reservationId,
      repaidAmount: movement.repaidAmount,
      releasedAmount: movement.releasedAmount,
      occurredAt: movement.occurredAt,
    };
  }

  private released(programId: string, repaymentId: RepaymentId): CapacityReleased | undefined {
    return this.store.movements.find(
      (m): m is CapacityReleased =>
        m instanceof CapacityReleased &&
        m.aggregateId === programId &&
        m.repaymentId.equals(repaymentId),
    );
  }
}

class InMemoryTreasuryEventLog implements TreasuryEventLog {
  constructor(private readonly store: InMemoryCapacity) {}

  async record(entry: TreasuryEventRecord): Promise<void> {
    if (this.store.treasuryEvents.some((seen) => seen.eventId === entry.eventId)) {
      throw new TreasuryEventAlreadyRecordedError(entry.eventId);
    }
    this.store.treasuryEvents.push(entry);
  }
}

class InMemoryReadModel implements CapacityReadModel {
  constructor(private readonly store: InMemoryCapacity) {}

  async getProgramCapacity(programId: ProgramId): Promise<ProgramCapacityView | null> {
    const snapshot = this.store.programs.get(programId.value);
    return snapshot === undefined ? null : toProgramCapacityView(Program.rehydrate(snapshot));
  }

  async listReservations(request: ReservationListRequest): Promise<ReservationView[]> {
    return [...this.store.reservations.values()]
      .filter((r) => r.programId.equals(request.programId))
      .filter((r) => request.status === null || r.status === request.status)
      .sort(newestFirst)
      .filter((r) => request.after === null || isAfter(r, request.after))
      .slice(0, request.limit)
      .map((r) => toReservationView(Reservation.rehydrate(r)));
  }
}

function newestFirst(a: ReservationSnapshot, b: ReservationSnapshot): number {
  const byTime = b.reservedAt.getTime() - a.reservedAt.getTime();
  return byTime !== 0 ? byTime : b.id.value.localeCompare(a.id.value);
}

function isAfter(
  r: ReservationSnapshot,
  cursor: { reservedAt: Date; reservationId: string },
): boolean {
  const time = r.reservedAt.getTime();
  const at = cursor.reservedAt.getTime();
  return time < at || (time === at && r.id.value < cursor.reservationId);
}

function replace<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

/** A clock that only moves when told to. */
export class FixedClock implements Clock {
  #now: Date;

  constructor(start: Date) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}
