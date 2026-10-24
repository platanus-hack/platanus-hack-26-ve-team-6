# Foundation verification — 2026-10-24

The integrated foundation passed its workspace build, strict typechecks, package tests, and isolated database/queue/HTTP suites. These checks establish the implemented local boundaries; they do not establish production readiness or the full product demonstration.

## Checks run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed with Node 24 and pnpm 11. |
| `pnpm peers check` | No peer dependency issues. The workspace pins a compatible OpenTelemetry API range for Pulumi's tracing SDKs. |
| `pnpm check` | All workspace builds and typechecks passed; 92 package tests passed. The default test command explicitly skipped 55 PostgreSQL cases without a test URL. |
| `pnpm --filter @gotchu/database test:postgres` | 36 passed: 7 database and 29 backend cases. Includes 28 real PostgreSQL cases and 8 units. |
| `pnpm --filter @gotchu/gateway test:postgres` | 23 passed: 18 real PostgreSQL cases, 3 configuration cases, and 2 actual Node HTTP/TLS transport cases using a fixture service. Certificate validation stayed enabled. |
| `pnpm --filter @gotchu/executor test:postgres` | 35 passed: 9 real PostgreSQL integrations and 26 orchestration/adapter cases. Provider and MFA inputs were fixtures. |
| `pnpm test:integration` | 14 passed against fresh PostgreSQL and Redis containers, including the actual HTTP gateway, HTTP worker, LangGraph, reserved deterministic delivery lane, and recovery behind an investigation backlog. |
| `pnpm exec tsc -p test/tsconfig.json` | Integration tests and their web/database boundaries passed strict checking. |
| `git diff --check` | Passed before the focused implementation commits. |
| `scripts/infra-live-check.sh` | Real web/coordinator images built and ran nonroot with read-only roots. Persistent data survived restart; both role-bootstrap passes, loopback binds, readiness, GitHub TLS, disabled profiles, graceful shutdown, and cleanup checks passed. |

Across these suites, 161 distinct test cases passed, including 69 that use real PostgreSQL. Repeated executions of the same case are not counted twice. Live runners use generated credentials, random loopback ports, isolated test databases, and cleanup in `finally`; they do not reuse customer data or existing database volumes.

## Important failure cases exercised

- Tenant and application scope, forged identity headers, signed intake, repeated delivery, concurrent UUID-equivalent replay, and atomic event/outbox persistence.
- Lost, completed, or failed Redis delivery records with unfinished durable Postgres intent.
- A newly accepted signed event finishes while two investigation fixtures remain blocked and a third waits, through both outbox delivery and reconciliation using the production transport factory.
- Atomic run/job completion, rollback after an injected final write failure, stale lease rejection, and recovery after a terminal checkpoint was saved but the coordinator stopped before finalization.
- Concurrent aggregation without incident-count regression. Signed year-zero timestamps are rejected; legacy incompatible timestamps remain retained, are excluded from detector windows, and keep coverage degraded.
- Expired and revoked capabilities, checkpoint scope/version checks, durable read idempotency, bounded input, tool budgets, and gateway TLS certificate validation.
- Exact approval identity, role revocation, one-use execution claims, frozen recovery, uncertain-outcome settlement, and executor retries through the real ledger.
- The model endpoint returns `503 model_not_configured`; the HTTP pipeline records a delayed investigation and zero model calls/spend.

Three Astra review rounds identified seven coordinator/HTTP issues. Focused commits and regressions address them; the final review reported no material remaining defect in the timestamp/quarantine and checkpoint-recovery changes. That was a scoped code review, not a production security assessment.

A subsequent architecture check found that investigations shared all event-processing slots. A separate deterministic queue now reserves one slot independently of the two investigation slots per coordinator. Recovery also selects a bounded batch per lane, so an investigation backlog cannot hide event jobs. Live regressions cover normal publication, transport recovery, and a backlog larger than a recovery batch; stop the old shared-queue coordinator before upgrading.

The built Nitro server was also started on a temporary loopback port: the homepage and liveness route returned 200, and missing database/auth configuration returned 503. Its process was stopped after the probe. Compose intentionally reports unready for missing OAuth or organization assignment; unavailable MFA and investigator setup remain explicit capability fields.

The final coordinator image was rebuilt after the recovery-selector change and loaded its transport/recovery exports as UID 1000 with networking disabled and no data credentials. The pipeline's intake leg uses the production Request/Response adapter through an injected SDK fetch; gateway/worker legs use real HTTP sockets. A positive signed-event POST through the built Nitro host over TCP was not part of these checks.

## Limits of this evidence

OAuth callbacks against a live GitHub application, production MFA and trusted eligibility verifiers, real model/provider calls, GitHub PR writes, scanner execution, disposable customer-code VMs, deployed gateway/worker TLS, backups/restoration, quotas/retention, alert delivery, representative-traffic calibration, capacity, latency, and operating cost remain unproven or unimplemented. Pulumi policy tests use mocks; no cloud resources were deployed. CI configuration is committed, but remote GitHub Actions results have not been claimed.

The first full product demonstration still needs the vulnerable-dependency scanner path and an approved tested GitHub PR. Current tests prove the event/investigation foundation and execution authorization ledger using explicitly labeled external fixtures.

The production web build emits upstream Nitro/Rolldown warnings about bundled `use client` directives. The build passes; these warnings have not been suppressed. No repository lint script is defined.
