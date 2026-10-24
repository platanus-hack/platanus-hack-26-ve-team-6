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
| `pnpm test:integration` | 11 passed against fresh PostgreSQL and Redis containers, including the actual HTTP gateway, HTTP worker, and LangGraph. |
| `pnpm exec tsc -p test/tsconfig.json` | Integration tests and their web/database boundaries passed strict checking. |
| `git diff --check` | Passed before the focused implementation commits. |

Across these suites, 158 distinct test cases passed, including 66 that use real PostgreSQL. Repeated executions of the same case are not counted twice. Live runners use generated credentials, random loopback ports, isolated test databases, and cleanup in `finally`; they do not reuse customer data or existing database volumes.

## Important failure cases exercised

- Tenant and application scope, forged identity headers, signed intake, repeated delivery, concurrent UUID-equivalent replay, and atomic event/outbox persistence.
- Lost, completed, or failed Redis delivery records with unfinished durable Postgres intent.
- Atomic run/job completion, rollback after an injected final write failure, stale lease rejection, and recovery after a terminal checkpoint was saved but the coordinator stopped before finalization.
- Concurrent aggregation without incident-count regression. Signed year-zero timestamps are rejected; legacy incompatible timestamps remain retained, are excluded from detector windows, and keep coverage degraded.
- Expired and revoked capabilities, checkpoint scope/version checks, durable read idempotency, bounded input, tool budgets, and gateway TLS certificate validation.
- Exact approval identity, role revocation, one-use execution claims, frozen recovery, uncertain-outcome settlement, and executor retries through the real ledger.
- The model endpoint returns `503 model_not_configured`; the HTTP pipeline records a delayed investigation and zero model calls/spend.

Three Astra review rounds identified seven coordinator/HTTP issues. Focused commits and regressions address them; the final review reported no material remaining defect in the timestamp/quarantine and checkpoint-recovery changes. That was a scoped code review, not a production security assessment.

## Limits of this evidence

OAuth callbacks against a live GitHub application, production MFA and trusted eligibility verifiers, real model/provider calls, GitHub PR writes, scanner execution, disposable customer-code VMs, deployed gateway/worker TLS, backups/restoration, quotas/retention, alert delivery, representative-traffic calibration, capacity, latency, and operating cost remain unproven or unimplemented. Pulumi policy tests use mocks; no cloud resources were deployed. CI configuration is committed, but remote GitHub Actions results have not been claimed.

The first full product demonstration still needs the vulnerable-dependency scanner path and an approved tested GitHub PR. Current tests prove the event/investigation foundation and execution authorization ledger using explicitly labeled external fixtures.

The production web build emits upstream Nitro/Rolldown warnings about bundled `use client` directives. The build passes; these warnings have not been suppressed. No repository lint script is defined.
