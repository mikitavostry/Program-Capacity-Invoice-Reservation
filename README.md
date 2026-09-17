# Program Capacity & Invoice Reservation

Service that tracks a financing program's credit capacity in real time: invoices reserve
capacity when approved for early payment, and release it back when repaid. Capacity data
also arrives from an external treasury system over Kafka, including periodic bulk
reconciliation messages. Programs and invoices may be denominated in different currencies.

> Status: project scaffold. Domain modules are not implemented yet.

## Stack

| Concern    | Choice                                  |
| ---------- | --------------------------------------- |
| Runtime    | Node.js >= 22.19                        |
| Framework  | NestJS 12 (ESM, `"type": "module"`)     |
| Language   | TypeScript 6, `strict` mode             |
| Tests      | Vitest (unit + e2e)                     |
| Lint       | oxlint                                  |
| Formatting | Prettier                                |

Because the project is ESM, relative imports must carry a `.js` extension
(`import { AppModule } from './app.module.js'`) even though the source is `.ts`.

## Running locally

```bash
npm ci
npm run start:dev
```

The API listens on `http://localhost:3000` (override with `PORT`).

## Scripts

| Script             | Purpose                        |
| ------------------ | ------------------------------ |
| `npm run start:dev`| Watch-mode dev server          |
| `npm run build`    | Compile to `dist/`             |
| `npm start`        | Run without watch              |
| `npm test`         | Unit tests                     |
| `npm run test:cov` | Unit tests with coverage       |
| `npm run test:e2e` | End-to-end tests               |
| `npm run lint`     | Lint `src/` and `test/`        |
| `npm run format`   | Format with Prettier           |

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
| Concurrency | Optimistic version column with bounded retry |
| Currency | Convert on reservation, snapshot the rate, replay it on release |
| Rounding | Round up — the reserved amount is a risk exposure hold, not a settlement figure |
| Auth | JWT bearer with a default-deny global guard |

Kafka ingestion from the treasury system is deferred; the seam it attaches to is described
in §12 of the architecture document.

## Notes and trade-offs

- **Use `npm ci`, not a from-scratch `npm install`.** npm 10.9.3 (bundled with Node 22.19)
  hits an `arborist` bug — `Cannot read properties of null (reading 'edgesOut')` — while
  resolving Vitest 4's peer graph from scratch. Installing against the committed
  `package-lock.json` avoids re-resolution and works normally. If the lockfile ever has to
  be regenerated on this npm version, use `npm install --legacy-peer-deps`; upgrading to
  npm 11 removes the need for the flag.
- `@nestjs/mau` (the optional Nest deploy CLI) was removed from the scaffold. It was the
  sole source of all 5 reported vulnerabilities and the project does not deploy through it.
  `npm audit` is now clean.
