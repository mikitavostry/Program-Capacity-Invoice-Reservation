# Architecture

Domain-driven design for the Program Capacity & Invoice Reservation service.

This document records the structure and the reasoning behind it. Where a choice had a real
alternative, the alternative and the trade-off are stated rather than implied.

## 1. Context and scope

One bounded context is implemented: **Program Capacity**.

Two contexts are upstream and not owned here:

- **Invoicing** — we hold an `InvoiceId` and the invoice's amount and currency. We never
  model an Invoice. Whether it is approved, disputed or paid is not our concern; we are told
  to reserve and told to release.
- **Treasury** — the external system that feeds capacity changes and bulk reconciliation
  over Kafka. Deferred for now (see §12), but the seam it will attach to is fixed.

## 2. The dependency rule

```
presentation (HTTP) ─┐
                     ├──► application ──► domain
infrastructure ──────┘                      ▲
   (Prisma, FX)      │                      │
                     └── adapters implement ports the domain declares
```

The domain layer imports nothing: no NestJS, no Prisma, no decorators. This is not purity
for its own sake — it is what lets the capacity invariant be tested exhaustively in
milliseconds without a database or a DI container, and it is what stops persistence
concerns from quietly becoming business rules.

Ports are declared in `domain/ports` as plain TypeScript interfaces alongside a `Symbol`
injection token, because interfaces do not exist at runtime and Nest needs something
concrete to bind against. Adapters live in `infrastructure` and are wired in the module.

## 3. Structure

```
src/
├─ shared/
│  ├─ domain/              aggregate-root, entity, value-object, domain-event, domain-error
│  └─ money/               shared kernel: Money, Currency, ExchangeRate
├─ contexts/
│  └─ capacity/
│     ├─ domain/
│     │  ├─ program.ts            aggregate root — owns the capacity invariant
│     │  ├─ reservation.ts        aggregate root — the hold record
│     │  ├─ ids.ts                ProgramId, ReservationId, InvoiceId
│     │  ├─ events/               CapacityReserved, CapacityReleased
│     │  ├─ errors/               InsufficientCapacity, ProgramNotActive, ...
│     │  └─ ports/                ProgramRepository, ReservationRepository,
│     │                           ExchangeRateProvider, TransactionRunner
│     ├─ application/
│     │  ├─ reserve-capacity/     command + handler
│     │  ├─ release-capacity/     command + handler
│     │  ├─ create-program/       command + handler
│     │  ├─ get-program-capacity/ query + handler
│     │  └─ list-reservations/    query + handler
│     ├─ infrastructure/
│     │  ├─ persistence/prisma/   repositories, mappers, transaction runner
│     │  └─ fx/                   static rate provider (stand-in for a real FX service)
│     ├─ presentation/http/       controller, request/response DTOs, error filter
│     └─ capacity.module.ts
├─ iam/                    JWT guard, @Public(), program-scope authorization
├─ platform/               config + env validation, PrismaService, logging
├─ app.module.ts
└─ main.ts
```

`contexts/` rather than `modules/` is deliberate: it names bounded contexts, so a second
context later sits beside the first instead of dissolving into an undifferentiated pile of
feature folders.

## 4. Domain model

### 4.1 Program — aggregate root

```ts
class Program extends AggregateRoot<ProgramId> {
  private creditLimit: Money;
  private reservedAmount: Money;   // derived counter
  private readonly currency: Currency;
  private status: ProgramStatus;
  private version: number;

  get availableCapacity(): Money;                          // creditLimit − reservedAmount
  reserveFor(invoiceId, invoiceAmount, rate): Reservation;
  release(reservation: Reservation): void;
}
```

Invariants enforced inside the root:

- `0 ≤ reservedAmount ≤ creditLimit`
- every `Money` the program holds is denominated in the program's own currency
- a program must be `ACTIVE` to accept new reservations
- a credit limit may not be reduced below the amount currently reserved

### 4.2 Two aggregates, not one

`Program` and `Reservation` are **both** aggregate roots, referencing each other by identity
only. A `Reservation` holds a `ProgramId`, never a `Program` object.

The boundary test is: what has to be loaded together in order to check an invariant?
Enforcing `reservedAmount ≤ creditLimit` reads exactly one field on the program. It never
reads a reservation row. So reservations are not required to enforce the capacity invariant,
and putting them inside the boundary that protects it buys nothing.

The alternative — `Reservation` as a child entity of the `Program` aggregate — does not
survive contact with the implementation. A program may hold tens of thousands of
reservations, so the root cannot own them as a collection; each one is retrieved by its own
identity, modified on its own, and persisted through its own repository. An entity that is
loaded independently and modified independently is a root. Calling it a child would describe
the diagram rather than the code.

`Reservation` also guards invariants of its own (§4.3), which is the other half of what
makes something a root.

**What keeps the two in step.** `program.reserveFor(...)` returns the new `Reservation` —
one aggregate acting as a factory for another, the same shape as `Forum.startDiscussion()`
returning a `Discussion`. Moving the counter and recording the hold therefore cannot be done
separately: there is no code path to a `Reservation` that does not go through the capacity
check.

**Trade-off.** Both roots are written in a single transaction, which is a deliberate
exception to the "modify one aggregate per transaction" guideline. That guideline exists to
protect scalability; taking it literally here would mean eventual consistency on a credit
limit, i.e. transiently oversubscribing real money. Correctness wins, and the exception is
confined to two command handlers.

**The redundancy is checkable.** `Program.reservedAmount` is openly a denormalization of the
active reservation rows, so the two can be compared:

```sql
SELECT SUM(reserved_amount) FROM reservations
 WHERE program_id = $1 AND status = 'ACTIVE';   -- must equal programs.reserved_amount
```

Any divergence is a bug, which makes this a drift detector rather than a hidden assumption —
and it is exactly the assertion the bulk reconciliation path in §12 will want.

### 4.3 Reservation — aggregate root

The record of a single hold against a program. It records:

| Field | Purpose |
| --- | --- |
| `invoiceId` | the invoice this hold belongs to |
| `invoiceAmount` + currency | the original amount, as submitted |
| `reservedAmount` | the converted amount held, in program currency |
| `exchangeRate` + `rateAsOf` | the rate snapshot (see §8) |
| `status` | `ACTIVE` / `RELEASED` |
| `reservedAt` / `releasedAt` | audit timeline |

Invariants enforced inside this root:

- a reservation may be released once and only once
- the amount released equals the amount reserved — a release cannot return more or less
  capacity than the hold took
- the rate snapshot is immutable after creation; nothing re-prices an existing hold
- `invoiceAmount` and `reservedAmount` are equal only when both currencies match

Double release is caught at the database by a conditional update rather than a version
column, since there is only one transition to guard:

```sql
UPDATE reservations SET status = 'RELEASED', released_at = now()
 WHERE id = $1 AND status = 'ACTIVE'
```

Zero rows affected means it was already released, which the handler treats as a no-op (§7).

A released reservation is never deleted. The audit trail is a product requirement here, not
a debugging convenience.

## 5. Use cases (CQRS)

The application layer uses `@nestjs/cqrs` — one command or query per use case, dispatched
through the bus:

| Message | Kind |
| --- | --- |
| `ReserveCapacityCommand` | command |
| `ReleaseCapacityCommand` | command |
| `CreateProgramCommand` | command |
| `GetProgramCapacityQuery` | query |
| `ListReservationsQuery` | query |

The domain does **not** extend the `AggregateRoot` from `@nestjs/cqrs`. Our own base class
in `shared/domain` collects raised events; the command handler drains them and publishes to
the `EventBus` after the transaction commits. That keeps the domain framework-free while
still getting a publisher for free — which is precisely the hook Kafka attaches to later.

Reserve, end to end:

1. Controller validates the request DTO; the guard has already resolved the caller's scope.
2. Handler opens a transaction through the `TransactionRunner` port.
3. `ProgramRepository.findById` rehydrates the aggregate, including its `version`.
4. If the invoice currency differs, `ExchangeRateProvider.rateFor(...)` returns an
   `ExchangeRate` value object.
5. `program.reserveFor(invoiceId, amount, rate)` converts, checks capacity, and either
   throws `InsufficientCapacityError` or moves the counter and returns a `Reservation`.
6. Both are saved under a version check (§6); on success the events are published.

Release is the mirror, and needs no conversion at all — it replays
`reservation.reservedAmount`. That is what makes the snapshot decision in §8 hold together.

## 6. Concurrency — optimistic locking

The contended counter is the core risk in this service. Two approvals racing on the same
program must not jointly oversubscribe the limit.

**Chosen: an optimistic version column.** `Program` carries a `version`; the write is

```sql
UPDATE programs
   SET reserved_amount = $new, version = version + 1
 WHERE id = $id AND version = $expected
```

Zero rows affected means another transaction won the race, so the handler raises
`ConcurrencyConflictError` and rolls back. The reservation insert and the counter update
share the transaction, so they commit together or not at all.

Because conflicts are expected rather than exceptional, the command handler wraps the work
in a **bounded retry** — a small number of attempts with exponential backoff and jitter,
re-reading the aggregate fresh each time. Retrying is safe because of the idempotency
guarantee in §7: a retried reserve cannot produce a second hold. Exhausting the retries
returns `409 CONCURRENCY_CONFLICT` with a `Retry-After` hint rather than failing silently.

**Trade-off.** The alternative was a pessimistic `SELECT ... FOR UPDATE` row lock, which
serializes contenders with no retry logic and degrades more predictably when a single
program is hot. Optimistic locking holds no locks and keeps the database free of long-lived
transactions, at the cost of wasted work and a latency tail under contention. Because that
cost is load-dependent and invisible from the code, conflict rate is exported as a metric —
if one program concentrates conflicts, that is the signal to revisit this, and the decision
is isolated to the repository adapter and the retry wrapper.

## 7. Idempotency

A partial unique index enforces that an invoice can hold at most one live reservation
against a program:

```sql
CREATE UNIQUE INDEX ON reservations (program_id, invoice_id) WHERE status = 'ACTIVE';
```

- A replayed reserve returns the existing reservation instead of creating a second hold.
- A replayed release is a no-op that returns current state.

This matters at the HTTP layer today and matters considerably more once Kafka redelivery is
in play, so it is built in from the start rather than retrofitted.

## 8. Money and foreign exchange

### 8.1 Representation

Amounts are integer minor units held as `bigint`, always paired with a currency. `Money`
refuses cross-currency arithmetic — adding USD to EUR is a type error, not a runtime
surprise. No floating point is used anywhere in the money path. Exchange rates are stored as
fixed-scale decimals, and conversion is performed in integer arithmetic so there is no
intermediate binary floating-point representation to lose precision in.

### 8.2 Conversion and the rate snapshot

A program's capacity is denominated in a single currency. An invoice in a different currency
is converted at reservation time, and the rate used is stored on the reservation. Release
replays the stored reserved amount rather than re-converting.

**Trade-off.** A released amount will not equal the invoice's present-day value if the rate
has moved since. This is deliberate. Re-converting at release would make reserved and
released amounts disagree, so every rate movement would leak capacity in one direction or
the other, and available capacity would drift without bound and without anyone noticing.
Snapshotting keeps the capacity ledger internally consistent. Reconciling economic value
against the treasury system's view is what the bulk reconciliation messages are for — that
is a reconciliation problem, and it should be solved by reconciliation, not by arithmetic
that quietly disagrees with itself.

### 8.3 Rounding: round up

The converted `reservedAmount` is rounded **up** to the next minor unit.

The reasoning matters more than the rule. The reserved amount is not a settlement figure —
nobody is ever paid it. It is a risk exposure hold against a credit limit, and exposure
calculations in credit systems round conservatively, because their entire purpose is to
bound risk rather than to state a value fairly. Rounding up means rounding can never be the
cause of a limit breach. The cost is a sub-cent over-hold per invoice, which the release
returns intact.

The usual argument for banker's rounding is cumulative upward bias across many roundings.
It does not apply here: each reservation is rounded exactly once, the result is stored, and
release replays the stored value. Nothing is ever re-rounded, so there is no accumulation
and no drift to correct.

If a disbursement or settlement amount is introduced later, it is a different number and
takes conventional half-up rounding. Rounding policy attaches to the purpose of a figure,
not to the system as a whole.

## 9. HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /programs/:programId/capacity` | credit limit, reserved, available, currency |
| `POST /programs/:programId/reservations` | reserve capacity for an invoice |
| `POST /programs/:programId/reservations/:invoiceId/release` | release a reservation |
| `GET /programs/:programId/reservations` | paged audit trail |
| `POST /programs` | provisioning (admin scope) |

Release is a `POST` to a sub-resource rather than a `DELETE`, because nothing is deleted —
it is a lifecycle transition that produces a record.

All routes are authenticated by a globally registered JWT guard, with an explicit
`@Public()` decorator as the only opt-out, so a newly added endpoint is protected by default
rather than by remembering to protect it. Claims carry the caller's program scope, checked
before any program is touched.

Domain errors are translated in a single exception filter against a stable error-code
taxonomy:

| Code | Status |
| --- | --- |
| `INSUFFICIENT_CAPACITY` | 409 |
| `CONCURRENCY_CONFLICT` | 409 (with `Retry-After`) |
| `RESERVATION_NOT_FOUND` | 404 |
| `PROGRAM_NOT_ACTIVE` | 409 |
| `CURRENCY_NOT_CONVERTIBLE` | 422 |

The domain layer never mentions HTTP status codes.

## 10. Persistence mapping

Domain models and Prisma models are separate types joined by explicit mappers. Prisma's
generated types are a description of table shape, not of business behaviour, and letting
them into the domain would put the schema in charge of the model.

**Trade-off.** This is more code than using Prisma's types directly. It is the price of
being able to change the schema without changing the domain, and vice versa.

## 11. Testing strategy

| Layer | How |
| --- | --- |
| Domain | Pure Vitest. No Nest, no DB, no mocks. Invariants and money arithmetic. |
| Application | Handlers against in-memory fakes implementing the ports. |
| Integration | Real Postgres. Repository behaviour and the version-conflict path. |
| E2E | Supertest through the real HTTP stack, including auth. |

One integration test earns its keep above all others: N parallel reserves against a
nearly-exhausted program, asserting that the limit is never breached and that exactly the
right number of reservations succeed. It has to run against real Postgres, because what it
tests is the concurrency control, not the code around it.

## 12. Deferred: the Kafka seam

Kafka is out of scope for now. When it lands it attaches at
`contexts/capacity/infrastructure/messaging/`:

- a consumer as an **inbound adapter**, plus an **anti-corruption layer** translating
  treasury payloads into the same application commands the HTTP layer already dispatches;
- `program.reconcile(...)` on the aggregate for bulk state replacement, with the `version`
  column used to order and detect conflicting reconciliations;
- outbound domain events via a transactional **outbox** table.

Events are dispatched in-process until then. An outbox table that nothing reads would be
speculative work, and the point of the seam is that adding it changes no domain or
application code.

## 13. Decision log

| Decision | Chosen | Main alternative |
| --- | --- | --- |
| Persistence | PostgreSQL + Prisma | TypeORM |
| Application layer | `@nestjs/cqrs` buses | Plain application services |
| Concurrency control | Optimistic version column | Pessimistic `SELECT ... FOR UPDATE` |
| Aggregates | Program and Reservation as separate roots, written in one transaction | Reservation as a child entity of Program |
| FX on release | Replay snapshotted rate | Re-convert at live rate |
| Rounding | Round up (conservative exposure) | Half-up / banker's |
| Domain ↔ persistence | Explicit mappers | Prisma types as domain models |
| Auth | JWT bearer, default-deny guard | API keys, OAuth2 client credentials |
