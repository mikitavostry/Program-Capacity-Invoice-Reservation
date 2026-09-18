# Architecture

Domain-driven design for the Program Capacity & Invoice Reservation service.

This document records the structure and the reasoning behind it. Where a choice had a real
alternative, the alternative and the trade-off are stated rather than implied.

## 1. Context and scope

One bounded context is implemented: **Program Capacity**.

Two contexts are upstream and not owned here:

- **Invoicing** — we hold an `InvoiceId`, the invoice's amount and currency, and references
  to its repayments. We never model an Invoice. Whether it is approved, disputed or overdue
  is not our concern; we are told to reserve against it and told when it is repaid.
- **Treasury** — the external system that feeds capacity changes and bulk reconciliation
  over Kafka. Deferred for now (see §13), but the seam it will attach to is fixed.

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
│  ├─ domain/              aggregate-root, entity, value-object, identifier,
│  │                       domain-event, domain-error, invariant-violation-error
│  └─ money/               shared kernel: Money, Currency, ExchangeRate, rounding
├─ contexts/
│  └─ capacity/
│     ├─ domain/
│     │  ├─ program.ts            aggregate root — owns the capacity invariant
│     │  ├─ reservation.ts        aggregate root — one hold and its repayments
│     │  ├─ ids.ts                ProgramId, ReservationId, InvoiceId, RepaymentId
│     │  ├─ events.ts             ProgramOpened, CapacityReserved, CapacityReleased
│     │  ├─ errors.ts             InsufficientCapacity, RepaymentExceedsOutstanding, ...
│     │  └─ ports/                ProgramRepository, ReservationRepository,
│     │                           ExchangeRateProvider, TransactionRunner
│     ├─ application/
│     │  ├─ reserve-capacity/     command + handler
│     │  ├─ record-repayment/     command + handler
│     │  ├─ open-program/         command + handler
│     │  ├─ get-program-capacity/ query + handler
│     │  └─ list-reservations/    query + handler
│     ├─ infrastructure/
│     │  ├─ persistence/prisma/   repositories, mappers, ledger writer, transaction runner
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
  #creditLimit: Money;
  #reservedAmount: Money;   // denormalised counter
  #status: ProgramStatus;   // ACTIVE | SUSPENDED
  readonly version: number;

  get availableCapacity(): Money;                              // creditLimit − reservedAmount
  reserveFor(request: ReserveCapacity): Reservation;
  release(reservation: Reservation, repayment: ApplyRepayment): Money;
}
```

Invariants enforced inside the root:

- `0 ≤ reservedAmount ≤ creditLimit`
- every `Money` the program holds is denominated in the program's own currency
- a program must be `ACTIVE` to accept new reservations
- repayments are accepted whatever the status: capacity that has been repaid must be freed,
  even on a suspended program

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
returning a `Discussion` — and `program.release(reservation, repayment)` is the only path
that applies a repayment. Moving the counter and changing the reservation therefore cannot
be done separately from inside the domain.

**Trade-off.** Both roots are written in a single transaction, which is a deliberate
exception to the "modify one aggregate per transaction" guideline. That guideline exists to
protect scalability; taking it literally here would mean eventual consistency on a credit
limit, i.e. transiently oversubscribing real money. Correctness wins, and the exception is
confined to two command handlers.

**The redundancy is checkable.** `Program.reservedAmount` is openly a denormalisation, and
it can be recomputed two independent ways — from the reservations and from the ledger (§8):

```sql
SELECT SUM(reserved_minor - released_minor) FROM reservations
 WHERE program_id = $1 AND status = 'ACTIVE';            -- must equal programs.reserved_minor

SELECT SUM(CASE type WHEN 'RESERVE' THEN amount_minor ELSE -amount_minor END)
  FROM capacity_movements WHERE program_id = $1;         -- and so must this
```

Any divergence is a bug, which makes this a drift detector rather than a hidden assumption.

### 4.3 Reservation — aggregate root

The record of one hold against a program, and of the repayments that wind it down.

| Field | Purpose |
| --- | --- |
| `invoiceId` | the invoice this hold belongs to |
| `invoiceAmount` | the invoice's amount, in the invoice's currency |
| `reservedAmount` | the capacity held when the reservation was made, in program currency |
| `exchangeRate` | the rate snapshot, with its observation time; `null` if no conversion |
| `repaidAmount` | repaid so far, in invoice currency |
| `releasedAmount` | capacity freed so far, in program currency |
| `status` | `ACTIVE` while anything is outstanding, `RELEASED` once fully repaid |
| `reservedAt` / `releasedAt` | when it was made, and when the final repayment arrived |

Derived: `outstandingAmount = invoiceAmount − repaidAmount` and
`heldAmount = reservedAmount − releasedAmount`.

Invariants enforced inside this root:

- `0 ≤ repaidAmount ≤ invoiceAmount` and `0 ≤ releasedAmount ≤ reservedAmount`
- repayments are in the invoice's currency; a repayment larger than what is outstanding is
  refused rather than capped
- `RELEASED` exactly when fully repaid, and a fully repaid reservation has released
  **everything** it reserved — not a minor unit less
- the rate snapshot is immutable; nothing re-prices an existing hold
- without a rate, what was released always equals what was repaid

A released reservation is never deleted. The audit trail is a product requirement here, not
a debugging convenience.

### 4.4 Partial repayments

Invoices may be repaid in instalments, and each instalment frees its share of the hold.

A repayment is stated in the **invoice's** currency — "invoice X was repaid €40" is what the
invoicing context knows. For a converted reservation that raises the question of how much
program-currency capacity €40 frees. Two rules answer it:

1. **Compute from the running total, never per instalment.** The capacity freed so far is
   derived from the *cumulative* amount repaid, and each instalment frees the difference
   between the new total and the old one. Rounding therefore happens once, on the total,
   instead of accumulating an error per instalment.
2. **Round partial releases down; the final repayment settles exactly.** Until the invoice
   is fully repaid, capacity freed is `floor(repaid × rate)`, so an instalment can never
   free more than its share. The repayment that clears the invoice frees whatever is still
   held, so the total released equals the total reserved to the minor unit, however the
   repayments were split.

Worked example — €0.03 at 1.095 is $0.03285, held as $0.04 after rounding up (§9.3).
Three €0.01 instalments free $0.01, $0.01, then the remaining $0.02. The total is $0.04.

A consequence worth stating: an instalment worth less than one minor unit of the program's
currency frees nothing at the time. It is still recorded, and later repayments catch up.

## 5. Use cases (CQRS)

The application layer uses `@nestjs/cqrs` — one command or query per use case, dispatched
through the bus:

| Message | Kind |
| --- | --- |
| `ReserveCapacityCommand` | command |
| `RecordRepaymentCommand` | command |
| `OpenProgramCommand` | command |
| `GetProgramCapacityQuery` | query |
| `ListReservationsQuery` | query |

The domain does **not** extend the `AggregateRoot` from `@nestjs/cqrs`. Our own base class
in `shared/domain` collects raised events; the command handler drains them, writes them to
the ledger inside the transaction, and publishes them to the `EventBus` after it commits.
That keeps the domain framework-free while still getting a publisher for free — which is
precisely the hook Kafka attaches to later.

Reserve, end to end:

1. Controller validates the request DTO; the guard has already resolved the caller's scope.
2. If the invoice currency differs from the program's, `ExchangeRateProvider.rateFor(...)`
   fetches the rate — **before** any transaction is opened (§6).
3. Handler opens a transaction and locks the program row (`findByIdForUpdate`).
4. If the invoice already has an active reservation on this program, the existing one is
   returned unchanged (§7).
5. `program.reserveFor(...)` converts, checks capacity, and either throws
   `InsufficientCapacityError` or moves the counter and returns a `Reservation`.
6. Program, reservation and ledger rows are written; the transaction commits; events are
   published.

Recording a repayment is the mirror: lock the program, load the reservation, check the
repayment id has not been applied already, `program.release(...)`, write, commit, publish.
No rate lookup is needed — the reservation carries its own.

## 6. Concurrency — pessimistic locking

The contended counter is the core risk in this service, and the contention is structural,
not incidental: every reservation and repayment against a program updates the same row.
A batch job approving twenty invoices on one program is twenty writers on one row.

**Chosen: lock the program row for the duration of the transaction.**

```sql
SELECT * FROM programs WHERE id = $1 FOR UPDATE;
```

Writers on one program queue and run one at a time; writers on different programs never
block each other. Under the lock, the aggregate's check-then-write is race-free, so the
invariant stays where it belongs — in the domain — and the database only has to serialise.

**Why not optimistic locking.** A version column with compare-and-set holds no locks, but
under a burst on one program only one writer wins each round: twenty concurrent reservations
cost on the order of two hundred attempts, each redoing its reads and its insert. Worse,
once a bounded retry budget runs out, a reservation is **rejected even though capacity was
available** — it failed from bad luck, not because the program was full. For a financing
product that is a business defect, not a performance one.

**Why not a single conditional `UPDATE`.** `UPDATE … SET reserved = reserved + $1 WHERE
limit − reserved ≥ $1` is correct and holds the row lock for the shortest possible time,
but the check that actually protects the limit moves into SQL and the aggregate's own check
becomes advisory. That is a fair trade in many ledgers; here it would hollow out the model.

**What pessimistic locking costs, and how each cost is bounded:**

| Cost | Mitigation |
| --- | --- |
| Throughput per program is serialised — ~1 / transaction time | Keep transactions short; different programs are independent. Far above realistic approval rates. |
| Anything slow inside the lock stalls every waiter | **No I/O inside the lock.** The FX rate is fetched before the transaction opens; the transaction contains only database statements. |
| Waiters hold pooled connections | `lock_timeout` (a few seconds) so waiters give up with a retryable `503 CAPACITY_BUSY` rather than exhausting the pool. |
| A stalled holder blocks everyone behind it | `idle_in_transaction_session_timeout` bounds how long an abandoned transaction can hold the lock. |
| Deadlocks | Structurally impossible as long as each transaction locks exactly one program row, first, before touching reservations. That ordering rule is load-bearing. |

**The `version` column stays** as a cheap assertion — under the lock a mismatch should be
impossible, so one appearing means a bug — and as a ready-made ETag for the HTTP layer.

## 7. Idempotency

**Reservations.** An invoice may hold at most one live reservation against a program:

```sql
CREATE UNIQUE INDEX ON reservations (program_id, invoice_id) WHERE status = 'ACTIVE';
```

Under the program lock, the handler's "does this invoice already have an active
reservation?" check is race-free, and a replay returns the existing reservation instead of
creating a second hold. The index is the backstop for any path that skips the check. Once a
reservation is fully released the invoice can be reserved again.

**Repayments.** Full release was naturally idempotent — a second attempt found nothing
left to release — but a partial one is not: "repay €40" replayed would free capacity twice.
Every repayment therefore carries a `RepaymentId` from the caller, recorded on its ledger
row under a unique constraint. A replay with the same id returns the original outcome
without applying anything; a replay that reuses the id with a *different* amount is refused,
because the caller has made a mistake that should not be silently papered over.

## 8. The capacity ledger

Every change to a program's `reservedAmount` produces exactly one immutable row in
`capacity_movements`, written in the same transaction as the counter:

| Type | Written when | Amount |
| --- | --- | --- |
| `RESERVE` | a reservation is made | capacity held, program currency |
| `RELEASE` | a repayment is applied | capacity freed (may be zero), plus the repayment in invoice currency |

The rows are the domain events (`CapacityReserved`, `CapacityReleased`) persisted — those
already carry everything a row needs, so the ledger is a writer, not a second model.

What it buys:

- **Audit.** Every movement of capacity is explained by a row that is never updated or
  deleted, with the repayment that caused it.
- **Drift detection.** `SUM(movements)` must equal the counter at all times (§4.2).
- **Repayment idempotency.** The unique `repayment_id` lives here (§7).
- **Somewhere for reconciliation to land.** Treasury corrections are not tied to any
  invoice; without a ledger they would overwrite the counter and leave no trace. They will
  be recorded as `ADJUSTMENT` movements (§13).

**This is not event sourcing**, and the distinction matters. In event sourcing the events
are the system of record and current state is rebuilt by replaying them, which brings
snapshots, replay tooling and versioned event schemas. Here the counter remains the
authority the capacity check reads; the ledger is an audit log alongside it. Nothing in the
brief needs more, and the extra machinery would be cost without benefit.

## 9. Money and foreign exchange

### 9.1 Representation

Amounts are integer minor units held as `bigint`, always paired with a currency. `Money`
refuses cross-currency arithmetic — adding USD to EUR is an error, not a runtime surprise.
No floating point is used anywhere in the money path. Exchange rates are fixed-scale
decimals (eight places), and conversion is a single integer division, so there is no
intermediate binary floating-point value to lose precision in.

### 9.2 Conversion and the rate snapshot

A program's capacity is denominated in a single currency. An invoice in a different currency
is converted at reservation time, and the rate used is stored on the reservation. Repayments
are converted back through that same stored rate — never a fresh one.

**Trade-off.** Capacity freed will not equal the invoice's present-day value if the rate
has moved since. This is deliberate. Re-converting at repayment would make reserved and
released amounts disagree, so every rate movement would leak capacity in one direction or
the other, and available capacity would drift without bound and without anyone noticing.
Snapshotting keeps the capacity ledger internally consistent. Reconciling economic value
against the treasury system's view is what the bulk reconciliation messages are for — that
is a reconciliation problem, and it should be solved by reconciliation, not by arithmetic
that quietly disagrees with itself.

### 9.3 Rounding

| Operation | Mode | Why |
| --- | --- | --- |
| Reserve (convert invoice → program currency) | `CEILING` | The hold must cover the exposure; rounding can never be what breaches a limit. |
| Partial repayment (release a share) | `FLOOR`, on the running total | Never free more than the share actually repaid. |
| Final repayment | exact remainder | Settles the difference, so released = reserved to the minor unit. |

The reserved amount is not a settlement figure — nobody is ever paid it. It is a risk
exposure hold against a credit limit, and exposure calculations in credit systems round
conservatively, because their purpose is to bound risk rather than to state a value fairly.
The cost is a sub-cent over-hold per invoice, held a little longer during repayment, which
the final repayment returns intact.

The usual argument for banker's rounding is cumulative bias across many roundings. It does
not apply: each reservation is rounded once, partial releases are computed from the running
total rather than rounded per instalment, and the final repayment settles exactly. Nothing
accumulates.

If a disbursement or settlement figure is introduced later, it is a different number and
takes conventional `HALF_UP`. Rounding policy attaches to the purpose of a figure, not to
the system as a whole.

## 10. HTTP API

| Endpoint | Purpose |
| --- | --- |
| `POST /programs` | open a program (admin scope) |
| `GET /programs/:programId/capacity` | credit limit, reserved, available, currency |
| `POST /programs/:programId/reservations` | reserve capacity for an invoice |
| `POST /programs/:programId/reservations/:invoiceId/repayments` | record a full or partial repayment |
| `GET /programs/:programId/reservations` | paged reservations with repayment state |

A repayment is a `POST` that creates a record, not a `DELETE` of the reservation — nothing is
deleted. The body carries the caller's `repaymentId` and, optionally, an amount; omitting
the amount repays whatever is outstanding.

All routes are authenticated by a globally registered JWT guard, with an explicit
`@Public()` decorator as the only opt-out, so a newly added endpoint is protected by default
rather than by remembering to protect it. Claims carry the caller's program scope, checked
before any program is touched.

Domain errors are translated in a single exception filter against a stable error-code
taxonomy:

| Code | Status |
| --- | --- |
| `INSUFFICIENT_CAPACITY` | 409 |
| `PROGRAM_NOT_ACTIVE` | 409 |
| `RESERVATION_ALREADY_RELEASED` | 409 |
| `REPAYMENT_ID_REUSED` | 409 |
| `PROGRAM_NOT_FOUND` / `RESERVATION_NOT_FOUND` | 404 |
| `INVALID_AMOUNT` | 422 |
| `REPAYMENT_EXCEEDS_OUTSTANDING` | 422 |
| `REPAYMENT_CURRENCY_MISMATCH` | 422 |
| `CURRENCY_NOT_CONVERTIBLE` / `UNSUPPORTED_CURRENCY` | 422 |
| `CAPACITY_BUSY` (lock timeout) | 503 with `Retry-After` |
| `INVARIANT_VIOLATION` | 500 — never the caller's fault |

The domain layer never mentions HTTP status codes.

## 11. Persistence

### 11.1 Mapping

Domain models and Prisma models are separate types joined by explicit mappers. Prisma's
generated types are a description of table shape, not of business behaviour, and letting
them into the domain would put the schema in charge of the model.

**Trade-off.** This is more code than using Prisma's types directly. It is the price of
being able to change the schema without changing the domain, and vice versa.

### 11.2 The database as a last line of defence

The aggregates are the primary guard of every invariant. The schema repeats the ones that
can be stated as constraints, so that a bug which slips past the domain and the lock still
cannot write a state the model says is impossible:

```sql
CHECK (credit_limit_minor > 0)
CHECK (reserved_minor >= 0 AND reserved_minor <= credit_limit_minor)
CHECK (repaid_minor  >= 0 AND repaid_minor  <= invoice_minor)
CHECK (released_minor >= 0 AND released_minor <= reserved_minor)
CHECK (amount_minor >= 0)                        -- ledger
```

Two further guards are structural rather than `CHECK`s:

- **Composite foreign keys** on `(program_id, currency)` pin a reservation's held currency,
  and every ledger row's currency, to its program's. A reservation cannot hold euros against
  a dollar program even if code tried to write one.
- **A trigger rejects any `UPDATE` or `DELETE`** on `capacity_movements`, so the ledger is
  append-only in the database, not merely by convention. (It does not stop `TRUNCATE`; in
  production the application's role should not be granted that.)

The concurrency integration test proves the lock is load-bearing: with `FOR UPDATE` removed,
only 3 of 30 concurrent reservations succeed — the rest are lost updates, which the `version`
assertion catches and reports rather than letting the program oversubscribe.

Amounts are stored as `BIGINT` minor units next to a currency code — a single `NUMERIC(p, 2)`
column cannot represent currencies that subdivide into zero or three places. `BIGINT`'s
ceiling of about 9.2 × 10¹⁸ minor units is far beyond any realistic program.

## 12. Testing strategy

| Layer | How |
| --- | --- |
| Domain | Pure Vitest. No Nest, no DB, no mocks. Invariants, rounding, and repayment sequences. |
| Application | Handlers against in-memory fakes implementing the ports. |
| Integration | Real Postgres: repositories, constraints, the lock, and the lock-timeout path. |
| E2E | Supertest through the real HTTP stack, including auth. |

One integration test earns its keep above all others: N parallel reservations against a
nearly exhausted program, asserting that the limit is never breached, that exactly the right
number succeed, and that no reservation which fits is rejected. It has to run against real
Postgres, because what it tests is the concurrency control, not the code around it.

## 13. Deferred: the Kafka seam

Kafka is out of scope for now. When it lands it attaches at
`contexts/capacity/infrastructure/messaging/`:

- a consumer as an **inbound adapter**, plus an **anti-corruption layer** translating
  treasury payloads into the same application commands the HTTP layer already dispatches;
- `program.reconcile(...)` on the aggregate for bulk state replacement, recorded as
  `ADJUSTMENT` rows in the ledger, with treasury's own sequence numbers used to order and
  de-duplicate reconciliation messages;
- outbound domain events via a transactional **outbox**. The ledger is written in the same
  transaction as the state it describes, so it may serve as that outbox with a `published_at`
  column rather than duplicating it — to be decided when there is a publisher.

The point of the seam is that adding it changes no domain or application code.

## 14. Decision log

| Decision | Chosen | Main alternative |
| --- | --- | --- |
| Persistence | PostgreSQL + Prisma | TypeORM |
| Application layer | `@nestjs/cqrs` buses | Plain application services |
| Concurrency control | Pessimistic `SELECT … FOR UPDATE` on the program row | Optimistic version + retry; conditional `UPDATE` |
| Aggregates | Program and Reservation as separate roots, written in one transaction | Reservation as a child entity of Program |
| Repayments | Partial, applied in instalments, idempotent by `RepaymentId` | Full release only |
| Audit | Append-only capacity ledger alongside the counter | Reservation rows only; full event sourcing |
| FX on repayment | Replay the snapshotted rate | Re-convert at live rate |
| Rounding | `CEILING` to reserve, `FLOOR` on running total to release, exact final settlement | Half-up / banker's everywhere |
| Database constraints | `CHECK` constraints mirroring the invariants | Domain checks only |
| Domain ↔ persistence | Explicit mappers | Prisma types as domain models |
| Auth | JWT bearer, default-deny guard | API keys, OAuth2 client credentials |
