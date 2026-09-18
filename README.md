# Program Capacity & Invoice Reservation

Service that tracks a financing program's credit capacity in real time: invoices reserve
capacity when approved for early payment, and release it back when repaid. Capacity data
also arrives from an external treasury system over Kafka, including periodic bulk
reconciliation messages. Programs and invoices may be denominated in different currencies.

> Status: domain model and persistence are implemented and tested; the application layer,
> HTTP API and authentication are next.

## Stack

| Concern    | Choice                                  |
| ---------- | --------------------------------------- |
| Runtime    | Node.js >= 22.19                        |
| Framework  | NestJS 12 (ESM, `"type": "module"`)     |
| Language   | TypeScript 6, `strict` mode             |
| Database   | PostgreSQL 17 via Prisma 7.10 (pinned)  |
| Tests      | Vitest: unit, integration, e2e          |
| Lint       | oxlint                                  |
| Formatting | Prettier                                |

Because the project is ESM, relative imports must carry a `.js` extension
(`import { AppModule } from './app.module.js'`) even though the source is `.ts`.

## Running locally

Requires Docker, for Postgres.

```bash
cp .env.example .env     # local credentials; matches docker-compose.yml
npm ci                   # also generates the Prisma client
npm run db:up            # Postgres on localhost:5433, waits until healthy
npm run db:migrate       # apply migrations
npm run start:dev
```

The API listens on `http://localhost:3000` (override with `PORT`).

Postgres is published on **5433**, not 5432, so it does not collide with a Postgres already
installed on the machine. To change it, set `POSTGRES_PORT` and both URLs in `.env` together.

### Tests

```bash
npm test                 # unit — pure, no infrastructure, under a second or so
npm run test:int         # integration — needs `npm run db:up`
```

The integration suite runs against a separate `capacity_test` database that it drops and
rebuilds from the migrations on every run. It refuses to start against any database whose
name does not contain `test`, so it cannot be pointed at real data by mistake.

## Scripts

| Script             | Purpose                        |
| ------------------ | ------------------------------ |
| `npm run start:dev`| Watch-mode dev server          |
| `npm run build`    | Compile to `dist/`             |
| `npm start`        | Run without watch              |
| `npm test`         | Unit tests                     |
| `npm run test:int` | Integration tests (real Postgres) |
| `npm run test:cov` | Unit tests with coverage       |
| `npm run test:e2e` | End-to-end tests               |
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
