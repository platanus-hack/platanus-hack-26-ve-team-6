# Implementation status and release gates

## Current stage

Gotchu is in foundation implementation. The code establishes core package and trust boundaries, durable event/job state, a bounded investigation protocol, and infrastructure definitions. Several flows have local and database-backed tests, but tests do not turn missing external adapters or deployments into available product capabilities.

Hosted model requests currently return `503` without spending. The executor's provider writes are frozen. There is no production MFA or trusted approval verifier, cloud deployment, scanner service, customer-code execution, production TLS deployment, restore evidence, capacity evidence, or production operating-cost measurement.

## Foundation status

| Area | Present in code | Current limit |
| --- | --- | --- |
| HTTP and sign-in | TanStack Start server routes; Auth.js Core invoked by a custom server-side HTTP adapter; conditional GitHub OAuth sign-in; JWT sessions. | Auth.js sign-in is not repository access. Fresh MFA, a trusted step-up verifier, and production authentication configuration are not complete. |
| Domain and contracts | `@gotchu/contracts`, framework-independent `@gotchu/backend`, and `@gotchu/database` with migrations and separated runtime roles. | A production secret store and the trusted external identity/verifier adapters are absent. |
| Event intake and jobs | HMAC verification over exact raw event bytes, tenant derivation, duplicate/replay handling, and event-plus-outbox commit. Coordinator dispatches and reconciles Redis deliveries; Postgres owns durable intent. | Current coordinator jobs process event aggregation and investigation. Scanner scheduling, notification delivery, AWS, Cloudflare, and GitHub repository adapters are not wired. |
| Investigation | Bounded LangGraph worker over HTTP with run-scoped capabilities. Worker has no database, Redis, provider credentials, or signing private key. | The provider endpoint returns `503`; investigation is stored as unavailable with no model spend. |
| Run gateway | Run-capability validation, tenant-scoped reads, persistent sanitized checkpoints, budget enforcement, and HTTPS transport support. Loopback HTTP is limited to development/test. | There is no production certificate provisioning, deployed TLS path, or configured provider adapter. |
| Execution | Executor orchestration and a backend-ledger adapter using the restricted executor role. | A runnable provider service, trusted production approval verifiers, and GitHub write/provider adapters are absent. Provider writes stay disabled. |
| Local infrastructure | Persistent Compose data services and real nonroot web/coordinator images, with repeatable role bootstrap, readiness probes, and complete cleanup. | Gateway, worker, executor, and scanner profiles remain disabled. Public ingress TLS and restricted GitHub egress are not configured. |
| Cloud infrastructure | Pulumi definitions and mock policy tests for DigitalOcean network, firewall, droplets, and private object storage. | No cloud deployment. No application installation, scanner host runtime, VM sandbox, restore drill, or measured capacity/cost evidence. |
| Scanning and customer code | The customer-code execution gate is explicitly closed. | Scanner services are not runnable; customer dependency installation and customer tests are disabled. Docker is not the required VM-class isolation boundary. |

## Test coverage in the repository

This inventory describes test sources and their boundary; it is not a report that the checks were run for this documentation change.

- `@gotchu/contracts`: event and runtime-schema validation, including rejection of year-zero event timestamps.
- `@gotchu/database` and `@gotchu/backend`: tenant isolation, Postgres roles, signed intake, replay and duplicate behavior, outbox persistence, budget accounting, and exact proposal/approval/execution invariants.
- `@gotchu/web`: Auth.js HTTP behavior and authenticated API routes.
- `@gotchu/agent` and `@gotchu/worker`: run-capability checks, bounded investigation behavior, typed results, and HTTP worker boundaries.
- `@gotchu/gateway`: capability scope, tenant reads, budgets and idempotency, sanitized durable checkpoints, Postgres access, and HTTP/TLS transport fixtures.
- `@gotchu/executor`: independent ledger and execution policy, including Postgres-backed ledger behavior.
- `@gotchu/infra`: Pulumi resource/configuration policy under mocks; this does not contact DigitalOcean.
- `@gotchu/coordinator` and `test/integration/pipeline.test.ts`: event aggregation quarantines incompatible legacy timestamps and degrades coverage while retaining source events; a later valid batch can still produce an incident. Investigation recovery can atomically finalize a saved terminal checkpoint under the current lease after coordinator interruption and an expired run deadline, without calling the worker again.
- `test/integration/pipeline.test.ts`: isolated Postgres and Redis with web HTTP intake, coordinator/BullMQ delivery and recovery, aggregation, tenant isolation, and the investigation HTTP path. Two blocked investigation fixtures cannot stall deterministic jobs; a third investigation waits. Both outbox and recovery routes use the tested production transport factory. The model response is expected to be unavailable because no provider adapter is configured.

The live integration command exercises isolated local services. It does not prove production TLS, provider behavior, cloud deployment, restoration, scanner isolation, customer-code isolation, capacity, or cost.

## Commands

Root scripts are defined in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm build
pnpm typecheck
pnpm test
pnpm check
pnpm test:integration
```

`pnpm check` runs the workspace build, typecheck, and package tests; it does not include the live integration command. `pnpm test:integration` requires Docker and creates isolated, temporary Postgres and Redis containers for the HTTP pipeline.

The packages with explicit PostgreSQL test scripts expose:

```sh
pnpm --filter @gotchu/database test:postgres
pnpm --filter @gotchu/gateway test:postgres
pnpm --filter @gotchu/executor test:postgres
```

Each `test:postgres` script launches an isolated temporary PostgreSQL container, sets `GOTCHU_TEST_DATABASE_URL` for its test process, and requires Docker. Infrastructure scripts provide local setup and policy/live checks:

```sh
scripts/infra-local-setup.sh
scripts/infra-compose-validate.sh
scripts/infra-local-up.sh
scripts/infra-live-check.sh
scripts/infra-local-down.sh
pnpm --filter @gotchu/infra test
pnpm --filter @gotchu/infra typecheck
```

The Compose validation and live dependency check are separate from `pnpm check`. The Pulumi unit test uses mocks; it is not a cloud preview or deployment.

## Release gates

| Gate | Evidence required before enabling the capability |
| --- | --- |
| Production user authorization and approvals | Production Auth.js configuration, organization/membership policy, a trusted fresh-second-factor verifier, replay/expiry protection, and end-to-end negative authorization fixtures. Approval remains unavailable until then. |
| Integration credential custody | A production secret-store adapter for event signing keys and scoped provider credentials; key rotation and revocation behavior. Environment-provided local keys do not satisfy this gate. |
| Model investigation | A provider adapter behind the gateway; external-processing opt-in and data minimization; authoritative per-run token/spend ceilings in addition to existing organization reservations and call limits; settlement, timeouts, and unknown-outcome reconciliation. Agent-local guardrails are insufficient. Until configured, model requests stay `503` and spend zero. |
| Run gateway and worker transport | Deployed TLS with certificate/key lifecycle and authenticated coordinator-to-worker transport. Local TLS fixtures and fail-closed configuration are not production TLS evidence. |
| Provider writes | Trusted approval verification plus a real provider adapter that rechecks the exact approved action, target state, and automation safety; durable uncertain-outcome reconciliation. Until then, provider writes stay frozen. |
| Cloud coverage | Scoped, least-privilege AWS and any selected Cloudflare adapters, with their authorization, freshness, and coverage behavior verified. No cloud connector or deployment is present now. |
| Static scanners | Runnable pinned scanner images/profiles, scoped input and result paths, resource/output limits, and evidence provenance. Scanner Compose profile currently exits unavailable. |
| Customer-code execution | A demonstrated disposable VM-class boundary per job, controlled networking, bounded resources, no credentials, and independent rescanning/relevant validation. Customer tests and dependency installation remain disabled. |
| Cloud deployment | Reviewable Pulumi plan and operator-controlled deployment followed by service configuration and health checks. Current DigitalOcean definitions and mock tests do not show a deployed environment. |
| Restore and operations | A clean-environment restore drill, recovery authorization reconciliation, measured capacity/load behavior, provider pricing, and an evidenced operating-cost estimate. Existing recovery, capacity, and budget figures remain planning targets, not guarantees. |

The historical accepted requirements and provisional pilot targets remain in [the definition interview](definition-interview.md). Keep that record intact; update implementation status here only when the corresponding code, adapters, tests, or operational evidence exist.
