# Program Capacity & Invoice Reservation

Service that tracks a financing program's credit capacity in real time: invoices reserve
capacity when approved for early payment, and release it back when repaid. Capacity data
also arrives from an external treasury system over Kafka, including periodic bulk
reconciliation messages. Programs and invoices may be denominated in different currencies.

> Status: complete and runnable — HTTP API, authentication, and the Kafka treasury feed.

## Stack

| Concern    | Choice                                  |
| ---------- | --------------------------------------- |
| Runtime    | Node.js >= 22.19                        |
| Framework  | NestJS 12 (ESM, `"type": "module"`)     |
| Language   | TypeScript 6, `strict` mode             |
| Database   | PostgreSQL 17 via Prisma 7.10 (pinned)  |
| Messaging  | Kafka (Redpanda locally), Confluent client |
| Tests      | Vitest: unit, integration, e2e          |
| Lint       | oxlint                                  |
| Formatting | Prettier                                |

Because the project is ESM, relative imports must carry a `.js` extension
(`import { AppModule } from './app.module.js'`) even though the source is `.ts`.

## Running locally

Requires Docker, for Postgres and Kafka.

```bash
cp .env.example .env     # local settings; matches docker-compose.yml
npm ci                   # also generates the Prisma client
npm run db:up            # Postgres on 5433 and Kafka on 19092, waits until healthy
npm run db:migrate       # apply migrations
npm run start:dev        # http://localhost:3000
```

Postgres is published on **5433**, not 5432, so it does not collide with a Postgres already
installed on the machine. To change it, set `POSTGRES_PORT` and both URLs in `.env` together.

### Calling the API

Every endpoint except `/health/*` needs a bearer token. Mint one for local use:

```bash
TOKEN=$(npm run token --silent)          # every scope, every program
```

`npm run token -- --scope capacity:read --programs program-1` narrows it. Then:

```bash
# Open a program (admin)
curl -X POST localhost:3000/programs -H "Authorization: Bearer $TOKEN"   -H 'Content-Type: application/json'   -d '{"programId":"program-1","creditLimit":{"amount":"10000000.00","currency":"USD"}}'

# Reserve capacity for an invoice — in another currency, converted at today's rate
curl -X POST localhost:3000/programs/program-1/reservations -H "Authorization: Bearer $TOKEN"   -H 'Content-Type: application/json'   -d '{"invoiceId":"invoice-1","amount":{"amount":"100000.00","currency":"EUR"}}'

# Record a partial repayment (omit "amount" to repay whatever is outstanding)
curl -X POST localhost:3000/programs/program-1/reservations/invoice-1/repayments   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"repaymentId":"repayment-1","amount":{"amount":"40000.00","currency":"EUR"}}'

# Current availability, and the reservations behind it
curl localhost:3000/programs/program-1/capacity -H "Authorization: Bearer $TOKEN"
curl 'localhost:3000/programs/program-1/reservations?limit=20' -H "Authorization: Bearer $TOKEN"
```

Amounts are always `{"amount": "<decimal string>", "currency": "<ISO 4217>"}` — strings, never
JSON numbers, which cannot carry money exactly. Errors come back as RFC 9457
`application/problem+json` with a stable `code`; the full list is in the
[architecture document](docs/architecture.md#10-http-api).

### The treasury feed

Treasury owns each program's credit limit and publishes changes over Kafka. The feed is off
by default so the API runs without a broker; turn it on and send it something:

```bash
KAFKA_ENABLED=true npm run start:dev

npm run treasury -- --program program-1 --limit 2500000.00 --sequence 1   # capacity change
npm run treasury -- --program program-1 --limit 2500000.00 --sequence 2                     --reserved 125000.00                                  # bulk reconciliation
npm run treasury -- --program program-1 --malformed                       # goes to dead letters
```

Two behaviours worth knowing, both deliberate and explained in
[§13](docs/architecture.md#13-the-treasury-feed):

- **Treasury can cut a limit below what is already reserved.** Existing holds stand, the
  program goes *over limit* (available capacity is negative), and new reservations are refused
  until repayments bring it back under.
- **Reconciliation never overwrites what we hold reserved.** A difference between treasury's
  figure and ours is reported as a discrepancy, because ours is the one backed by per-invoice
  reservations and an immutable ledger.

Messages that can never succeed — not JSON, not the schema, an unknown program — are parked
in the dead-letter topic with the reason, rather than blocking the feed:

```bash
docker compose exec redpanda rpk topic consume treasury.program-capacity.dead-letter --num 1
```

### Tests

```bash
npm test                 # unit — pure, no infrastructure
npm run test:int         # integration — real Postgres and Kafka; needs `npm run db:up`
npm run test:e2e         # end to end — the whole app over HTTP; needs `npm run db:up`
```

The integration and end-to-end suites run against a separate `capacity_test` database that
is dropped and rebuilt from the migrations on every run. They refuse to start against any
database whose name does not contain `test`, so they cannot be pointed at real data by
mistake.

## Scripts

| Script             | Purpose                        |
| ------------------ | ------------------------------ |
| `npm run start:dev`| Watch-mode dev server          |
| `npm run build`    | Compile to `dist/`             |
| `npm start`        | Run without watch              |
| `npm test`         | Unit tests                     |
| `npm run test:int` | Integration tests (real Postgres) |
| `npm run test:cov` | Unit tests with coverage       |
| `npm run test:e2e` | End-to-end tests over HTTP (real Postgres) |
| `npm run token`    | Mint a local bearer token      |
| `npm run treasury` | Publish a treasury message to the local feed |
| `npm run lint`     | Lint `src/` and `test/`        |
| `npm run typecheck`| Type-check everything, tests included |
| `npm run format`   | Format with Prettier           |
| `npm run db:up` / `db:down` | Start / stop Postgres |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create a migration from schema changes |
| `npm run db:generate` | Regenerate the Prisma client (also runs on install) |

## Architecture

Domain-driven design, layered so the domain depends on nothing: presentation and
infrastructure both point inward at the application layer, which points at the domain.
Adapters implement ports the domain declares.

See **[docs/architecture.md](docs/architecture.md)** for the full model, the reasoning, and
the trade-offs behind each choice. In brief:

| Decision | Chosen |
| --- | --- |
| Persistence | PostgreSQL + Prisma, explicit domain-to-row mappers |
| Application layer | `@nestjs/cqrs` command and query buses |
| Aggregates | `Program` and `Reservation` as separate roots, written in one transaction |
| Concurrency | Pessimistic `SELECT … FOR UPDATE` on the program row, no I/O inside the lock |
| Repayments | Partial or full, idempotent by the caller's `RepaymentId` |
| Audit | Append-only capacity ledger alongside the counter — not event sourcing |
| Currency | Convert on reservation, snapshot the rate, replay it on every repayment |
| Rounding | `CEILING` to reserve, `FLOOR` on the running total to release, exact final settlement |
| Safety net | `CHECK` constraints mirroring the domain invariants |
| Auth | JWT bearer with a default-deny global guard |
| Treasury feed | Full state per message, ordered by sequence, idempotent by event id |
| Reconciliation | Reports a mismatch; never overwrites our reserved amount |

Kafka ingestion from the treasury system is deferred; the seam it attaches to is described
in §13 of the architecture document.

## Notes and trade-offs

- **Run `npm run typecheck` as well as the tests.** `nest build` excludes spec files and
  Vitest strips types without checking them, so a type error in a test would otherwise pass
  unnoticed.

- **Use `npm ci`, not a from-scratch `npm install`.** npm 10.9.3 (bundled with Node 22.19)
  hits an `arborist` bug — `Cannot read properties of null (reading 'edgesOut')` — while
  resolving Vitest 4's peer graph from scratch. Installing against the committed
  `package-lock.json` avoids re-resolution and works normally. If the lockfile ever has to
  be regenerated on this npm version, use `npm install --legacy-peer-deps`; upgrading to
  npm 11 removes the need for the flag.
- `@nestjs/mau` (the optional Nest deploy CLI) was removed from the scaffold. It was the
  sole source of the 5 advisories the scaffold shipped with.
- **Prisma is pinned to exactly 7.10.0**, CLI and client together. At the time of writing
  the CLI's `latest` npm tag pointed at an 8.0 release candidate while the client's pointed
  at 7.10; an unpinned install would have mixed a pre-release CLI with a stable client.
- **Accepted audit findings.** `npm audit` reports 4 high-severity advisories, all inside
  the `prisma` CLI: `mysql2` (bundled for MySQL support) and `deepmerge-ts` (used by the
  CLI's config loader). `@prisma/client` declares the CLI as an optional peer, so it is
  installed even with `--omit=dev` — "dev-only" is not the argument. Reachability is:
  `mysql2` only runs when connecting to MySQL, which this service never does, and
  `deepmerge-ts`' stack exhaustion needs a recursive object graph, while the CLI only ever
  merges our own trusted config file. Neither is reachable from a request to the service.
  The suggested fix, downgrading to Prisma 6, would be the worse trade. Revisit on each
  Prisma upgrade.
- **Hand-written SQL in migrations.** Prisma's schema language cannot express `CHECK`
  constraints or triggers, so the invariants the database repeats as a last line of
  defence — and the ledger's append-only trigger — are written by hand at the end of the
  migration. Partial unique indexes *are* in the schema (Prisma's `partialIndexes` preview
  feature), so `migrate dev` will not try to drop them.
