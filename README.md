# Gotchu foundation

Gotchu is building a security workflow platform for teams with technical staff and nontechnical owners. The current code is a backend and infrastructure foundation: it covers signed event intake, durable job delivery, deterministic event aggregation, a bounded investigation boundary, and an independent execution ledger.

This is not a completed security product. Hosted model calls return `503` because no provider adapter is configured; provider writes are disabled. Production MFA and trusted approval verifiers, cloud integrations, scanner services, customer-code execution, production TLS deployment, restore evidence, and capacity evidence are not in place.

## Architecture

The HTTP app is TanStack Start. It invokes Auth.js Core through a small server-side HTTP adapter. Domain logic lives in `@gotchu/backend`; persistence and migrations live in `@gotchu/database`. Postgres is authoritative for accepted work and outbox state. A persistent coordinator dispatches outbox entries to BullMQ on Redis and processes durable jobs. The isolated LangGraph worker has no database, Redis, provider credentials, or capability-signing private key. It calls the run gateway with a short-lived capability. The executor keeps its own durable ledger, while external provider writes remain frozen.

See [the as-built foundation architecture](docs/architecture.md), [current implementation status and gates](docs/implementation-plan.md), and the [architecture overview](docs/architecture-overview.html). The [definition interview](docs/definition-interview.md) remains the historical record of accepted product decisions and open requirements.

## Workspace commands

Use Node 24 and pnpm 11 as declared in the root manifest.

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm build
pnpm typecheck
pnpm test
pnpm check
```

`pnpm check` runs workspace build, typecheck, and unit tests. It does not run the live infrastructure pipeline. `pnpm test:integration` starts isolated temporary Postgres and Redis containers and exercises signed intake, outbox delivery/recovery, aggregation, tenant isolation, and the investigation HTTP path. It requires Docker and must be run separately; a passing mocked test is not a live infrastructure check.

Other useful commands from the package manifests and infrastructure scripts:

```sh
pnpm --filter @gotchu/database test:postgres
pnpm --filter @gotchu/gateway test:postgres
pnpm --filter @gotchu/executor test:postgres
scripts/infra-compose-validate.sh
scripts/infra-live-check.sh
```

The `test:postgres` package scripts each launch an isolated temporary PostgreSQL container and require Docker. `infra-live-check.sh` starts and removes its own local Docker project. The default Compose stack runs Postgres and Redis only; the application profiles are intentionally fail-closed placeholders.

## Current boundary

The Pulumi package defines a DigitalOcean network, firewall, droplets, and private Space, but no cloud deployment has been made. GitHub OAuth is configurable for sign-in; it is not a GitHub repository integration. AWS, Cloudflare, scanner execution, and customer-code tests are unavailable. Model requests return `503` and record no spend; PR creation is disabled.

Read the implementation status for what is present in code, test coverage, and the release gates that remain. Do not interpret proposed workload, budget, or recovery objectives as measured guarantees.
