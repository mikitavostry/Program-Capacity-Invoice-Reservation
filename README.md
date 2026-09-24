# Program Capacity & Invoice Reservation

Service that tracks a financing program's credit capacity in real time: invoices reserve
capacity when approved for early payment, and release it back when repaid. Programs and their
credit limits come from an external treasury system over Kafka, including periodic bulk
reconciliation messages. Programs and invoices may be denominated in different currencies.

What the service does, how it is built, and the assumptions and design decisions behind it:
**[docs/architecture.md](docs/architecture.md)**.

## Stack

| Concern    | Choice                                     |
| ---------- | ------------------------------------------ |
| Runtime    | Node.js >= 22.19                           |
| Framework  | NestJS 12 (ESM, `"type": "module"`)        |
| Language   | TypeScript 6, `strict` mode                |
| Database   | PostgreSQL 17 via Prisma 7.10 (pinned)     |
| Messaging  | Kafka (Redpanda locally), Confluent client |
| Tests      | Vitest: unit, integration, e2e; Newman     |
| Lint       | oxlint                                     |
| Formatting | Prettier                                   |

The project is ESM, so relative imports carry a `.js` extension
(`import { AppModule } from './app.module.js'`) even though the source is `.ts`.

## Running it

Two ways, both driven by npm scripts.

### Option A: everything in Docker

The API, Postgres, Kafka, the topics, the migrations and two demo programs (`program-1`,
10,000,000 USD; `program-2`, 5,000,000 EUR, published by a stand-in treasury).

Needs only Docker (with Compose) and npm to run the scripts: no install step and no `.env`.
Dependencies are installed inside the image, and the configuration is in `docker-compose.yml`.

| Step | Command |
| --- | --- |
| Start (builds the image, waits until healthy) | `npm run stack:up` |
| Get a bearer token | `TOKEN=$(npm run stack:token --silent)` |
| Publish a treasury message | `npm run stack:treasury -- --program program-3 --limit 750000.00 --currency GBP` |
| Follow the API's logs | `npm run stack:logs` |
| Stop | `npm run stack:down` (`npm run stack:down -- -v` also deletes the data) |

### Option B: the app on your machine, infrastructure in Docker

Hot reload, and `.env` for configuration. Needs Docker (with Compose) and Node.js 22.19 or newer.
Install dependencies once, and create the local config:

```bash
npm ci
cp .env.example .env
```

| Step | Command |
| --- | --- |
| Start Postgres and Kafka, create the topics, apply the migrations | `npm run infra:up` |
| Start the API with hot reload | `npm run start:dev` |
| Open a program (programs only come from treasury) | `npm run treasury -- --program program-1 --limit 10000000.00 --currency USD` |
| Get a bearer token | `TOKEN=$(npm run token --silent)` |
| Stop the infrastructure | `npm run infra:down` |

### Either way

| What | Where |
| --- | --- |
| API | <http://localhost:3000> |
| Health | <http://localhost:3000/health/ready> → `{"status":"ok"}` |
| OpenAPI (Swagger UI) | <http://localhost:3000/docs>; **Authorize** with `$TOKEN`. JSON at `/docs/openapi.json` |
| Kafka web UI (Redpanda Console) | <http://localhost:8080>; in option B start it with `npm run kafka:ui` |
| Kafka over HTTP (used by Postman) | <http://localhost:18082> |
| Postgres | `localhost:5433` (not 5432, to avoid a local Postgres; change `POSTGRES_PORT` and `DATABASE_URL` together) |

A token grants every scope on every program for one hour. To narrow it, add for example
`-- --scope capacity:read --programs program-1`. The scopes are `capacity:read`,
`reservations:write` and `repayments:write`.

## Calling the API

Programs are opened by treasury (the Docker stack seeds `program-1`), so the API starts from
reading one:

```bash
# Current availability
curl localhost:3000/programs/program-1/capacity -H "Authorization: Bearer $TOKEN"

# Reserve capacity for an invoice (EUR, converted into the program's USD)
curl -X POST localhost:3000/programs/program-1/reservations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"invoice-1","invoiceAmount":{"amount":"100000.00","currency":"EUR"}}'

# Record a partial repayment (omit "amount" to repay everything outstanding)
curl -X POST localhost:3000/programs/program-1/reservations/invoice-1/repayments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"repaymentId":"repayment-1","amount":{"amount":"40000.00","currency":"EUR"}}'

# Current availability, and the reservations behind it
curl localhost:3000/programs/program-1/capacity -H "Authorization: Bearer $TOKEN"
curl 'localhost:3000/programs/program-1/reservations?limit=20' -H "Authorization: Bearer $TOKEN"
```

Once an invoice has been fully repaid, reserving it again needs a new `"reservationKey"` in the
body; without one the request is refused (`409 INVOICE_ALREADY_REPAID`) as a possible late retry
of the original. See [safe retries](docs/architecture.md#26-safe-retries).

Amounts are always `{"amount": "<decimal string>", "currency": "<ISO 4217>"}` — strings, not
JSON numbers. Errors are returned as RFC 9457 `application/problem+json` with a `code`; the full
list is in the [architecture document](docs/architecture.md#37-http-api).

**API documentation:** <http://localhost:3000/docs> (Swagger UI; use **Authorize** with a token)
and <http://localhost:3000/docs/openapi.json>.

## Postman collection

[`docs/postman/invoice-reservation.postman_collection.json`](docs/postman/invoice-reservation.postman_collection.json)
contains **40 requests** covering the whole service. Every request has tests asserting the
expected status and body, so running the collection checks the service end to end — including
the Kafka feed.

| Folder | What it covers |
| --- | --- |
| 1. Health | liveness and readiness |
| 2. Programs | treasury publishes a new program over Kafka; capacity once the feed has opened it; no HTTP endpoint for opening; unknown program |
| 3. Reservations | same-currency and EUR reservations, repeats, insufficient capacity, invalid body, cursor paging |
| 4. Repayments | partial and full repayment, repeated and reused repayment ids, overpayment, a repaid invoice not reserved again without a new key, final capacity |
| 5. Authentication and authorization | missing and tampered tokens, read-only token, reservations-only and repayments-only tokens, wrong program |
| 6. Treasury updates | treasury raises the limit; a periodic reconciliation; treasury suspends the program (reservation refused) and reactivates it |

**How to use it:**

1. Start the service ([either way](#running-it)). Both expose what the collection needs:
   the API on port 3000 and Kafka's HTTP proxy on port 18082.
2. In Postman: **Import** → select the collection file.
3. Open the collection and click **Run**.

No setup is needed:

- **Tokens are generated by the collection.** A collection-level pre-request script signs JWTs
  with the `jwtSecret`, `jwtIssuer` and `jwtAudience` variables, which match the local config.
  It creates several tokens (full access, read-only, reservations-only, repayments-only,
  another program's, tampered) for the auth tests.
- **The collection plays treasury itself.** Postman cannot speak Kafka, so the requests that
  publish treasury messages go through Redpanda's HTTP proxy (`kafkaProxyUrl`,
  `http://localhost:18082`) to the `treasuryTopic`. The request after each one polls the
  capacity endpoint until the feed has applied the message.
- **Each run publishes a new program** (`postman-<timestamp>`), so the collection can be run
  repeatedly against the same database.
- Ids created along the way (invoice, reservation, repayment, paging cursor) are stored in
  collection variables and used by the following requests. Run the folders in order.

To test another environment, change `baseUrl` and `kafkaProxyUrl`, and set `jwtSecret`,
`jwtIssuer` and `jwtAudience` to that environment's values.

**Without Postman**, run the same collection from the command line with Newman (the service must
be running on `localhost:3000`, with the broker's HTTP proxy on `localhost:18082`):

```bash
npm run test:api
```

## Acting as treasury

Programs are opened and changed only by treasury messages on Kafka. Locally, publish them with
the `treasury` script (with the stack in Docker, use `npm run stack:treasury` instead):

```bash
npm run treasury -- --program program-3 --limit 750000.00 --currency GBP   # open, or change the limit
npm run treasury -- --program program-3 --status SUSPENDED                 # or ACTIVE
npm run treasury -- --program program-3 --limit 900000.00 --currency GBP --status ACTIVE --reconcile
npm run treasury -- --program program-3 --malformed                        # lands in the dead-letter topic
```

Then check `GET /programs/program-3/capacity`. Alternatives: **Produce record** on the
`treasury.program-capacity` topic in Redpanda Console (<http://localhost:8080>), or an HTTP
POST to Kafka's proxy, as the Postman collection does:

```bash
curl -X POST localhost:18082/topics/treasury.program-capacity \
  -H 'Content-Type: application/vnd.kafka.json.v2+json' \
  -d '{"records":[{"key":"program-5","value":{"eventId":"manual-2","eventType":"program.capacity.changed","occurredAt":"2026-09-21T10:00:00Z","sequence":1,"program":{"id":"program-5","creditLimit":{"amount":"100000.00","currency":"USD"}}}}]}'
```

Read the dead-letter topic:

```bash
docker compose exec redpanda rpk topic consume treasury.program-capacity.dead-letter --num 1
```

Message format and processing rules: [architecture §3.8](docs/architecture.md#38-treasury-feed).

## Events this service publishes

Every change — program opened, capacity reserved or released, limit or status changed — is
published to Kafka on `capacity.events`, keyed by program id, through a transactional outbox: an
event is published if and only if its change committed. Delivery is at least once; each message
has a stable `eventId`. Watch them in Redpanda Console, or:

```bash
docker compose exec redpanda rpk topic consume capacity.events --offset start
```

Details and the message format: [architecture §3.11](docs/architecture.md#311-published-events-transactional-outbox).

## Tests

The tests run on your machine, so install dependencies first with `npm ci` (no `.env` needed).

```bash
npm test                 # unit — no infrastructure needed
npm run test:int         # integration — real Postgres and Kafka in their own containers
npm run test:e2e         # end to end — real Postgres and Kafka in their own containers, HTTP API
npm run test:api         # Postman collection via Newman; needs a running service
npm run typecheck        # type-check everything, tests included
```

The end-to-end tests run the whole service against a real Kafka broker: a stand-in treasury
publishes programs and limit changes to a Kafka topic created for the test run, and the tests
then drive reservations and repayments over HTTP.

**Test containers.** `test:int` and `test:e2e` need only Docker running. Each run starts its own
Postgres and Kafka (Redpanda) containers with [Testcontainers](https://testcontainers.com), on
random ports, applies the migrations, runs the tests and removes the containers. They are
separate from the `docker compose` stack, which can stay up or down. The container setup is in
[`test/infrastructure/global-setup.ts`](test/infrastructure/global-setup.ts); the images match
`docker-compose.yml`. The first run pulls the images, so it takes longer.

Tests refuse to run against a database whose name does not contain `test`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run without watch |
| `npm test` | Unit tests |
| `npm run test:int` | Integration tests (real Postgres and Kafka) |
| `npm run test:e2e` | End-to-end tests (real Kafka, HTTP API) |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:api` | Run the Postman collection against a running service |
| `npm run token` | Mint a local bearer token |
| `npm run treasury` | Publish a treasury message to the local feed (opens or updates a program) |
| `npm run kafka:ui` | Start Redpanda Console (Kafka web UI) on port 8080 |
| `npm run stack:up` / `stack:down` / `stack:logs` | Whole stack in Docker |
| `npm run stack:token` / `stack:treasury` | `token` / `treasury`, run inside the Docker stack |
| `npm run infra:up` / `infra:down` | Postgres and Kafka for local development (up also creates topics and migrates) |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create a migration from schema changes |
| `npm run db:generate` | Regenerate the Prisma client (also runs on install) |
| `npm run lint` | Lint `src/`, `test/` and `scripts/` |
| `npm run typecheck` | Type-check everything, tests included |
| `npm run format` | Format with Prettier |

## Notes

- Run `npm run typecheck` as well as the tests: `nest build` skips spec files and Vitest does not
  check types.
- Prisma is pinned to exactly 7.10.0, CLI and client together.
- `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`, both inside the
  Prisma CLI (the latest 7.x). Neither is reachable: the service never loads the CLI at runtime,
  migrations run against Postgres only, and the only config it merges is `prisma.config.ts`.
