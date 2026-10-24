# Implementation status and release gates

## Current stage

The current deliverable is a controlled assessment demonstration: a fixed vulnerable/corrected application, bounded source and independent HTTP profiles, persisted evidence-backed comparison reports, and a minimal Spanish dashboard. The public surface is scoped to an operator-seeded demo tenant and target. This is a narrow assessment profile, not general SAST or a production monitoring and response service.

The demo runs in observation mode and requires no model API, repository provider, identity vendor, or paid external service. Auth.js supports generic OIDC or optional GitHub sign-in, but live OAuth has not been demonstrated. AWS is the primary deployment target; the Pulumi foundation is mock-checked and not deployed.

## Current implementation

| Area | Present | Limit |
| --- | --- | --- |
| Dashboard and public demo API | Minimal Spanish dashboard loads persisted reports, shows evidence and coverage, starts a run, compares revisions, and exports JSON. The API injects a fixed operator-seeded organization, application, principal, and target. | Demo routes are public and intended only for fictional fixture data. They cannot access customer scopes or accept a target URL/path. This is not an authenticated customer workspace. |
| Admission bounds | Backend caps the fixed demo scope at three unfinished jobs and 100 lifetime jobs. Each web process also caps new idempotency keys at 10 per rolling minute and well-formed assessment POSTs at 30 per 60-second window. | HTTP limits are in-memory and per web process, not global quotas or measured throughput guarantees. The backend lifetime cap requires operator cleanup in a disposable demo environment. |
| Internal profile | Reads three fixed source/configuration files from a selected fixture; applies TypeScript AST/literal and configuration checks and one pinned offline lodash advisory, GHSA-35jh-r3h4-6jhm. | No general SAST, advisory freshness, lockfile/transitive/installed-package analysis, reachability, customer repository access, scripts, package installation, or customer-code execution. The corrected fixture removes an unused lodash declaration. |
| External profile | Source-independent, bounded GET to one fixed route on an operator-configured literal loopback/RFC1918 IPv4 HTTP origin; checks selected response headers and catalog response. | No arbitrary user URL, DNS target, redirect, retry, authentication, TLS, JavaScript execution, exploit attempt, or general web scan. A banner is only an indication. |
| Reports and comparison | Findings and reports preserve evidence provenance, checksums, coverage, confidence, severity, exploitability, limitations, and internal/external comparison classes. Reports are persisted under the fixed demo application. | Correlation does not prove source/deployment equivalence or exploitation. Missing or partial coverage stays unknown; no finding is not a secure result. |
| Tenant data | Customer/business tables use membership authorization, Postgres row-level security, and separate runtime roles. The public demo principal is restricted to assessment and job operations for the seeded scope. | The seeded demonstration scope and fictional reports are public by design; they contain no customer business data. |
| Durable processing | Assessment jobs are persisted with their outbox; the independent coordinator dispatches work through Redis/BullMQ and persists completed reports. The runner has one active slot per coordinator process and a 60-second overall timeout. | Local durability and tests do not establish production recovery, multi-region behavior, or measured capacity. |
| Identity | Auth.js Core supports a generic HTTPS OIDC issuer or optional GitHub OAuth sign-in. | No live OAuth provider has been verified. Sign-in does not imply repository access. Production MFA and trusted approval verification are absent. |
| Cloud foundation | AWS Pulumi definitions include two EC2 instances, private S3 artifact storage, network controls, and role-scoped storage policies. | Pulumi policy tests use mocks. There is no AWS deployment, live AWS check, configured customer connector, TLS ingress, restore drill, or measured capacity/cost. |
| Other product capabilities | Existing event intake, durable event pipeline, investigation worker/gateway, and executor ledger remain in the repository as separate foundation work. | Model calls return 503 without an explicitly configured provider. GitHub writes, monitoring integrations, alerts, approvals, containment, automatic response, recovery actions, scanners, and customer-code execution are not enabled by this demo. |

Incident severity never expands action authority. Observation, exact human approval, and bounded preauthorized automation remain distinct modes. Automatic response and cross-provider recovery are later release gates. No customer code, package scripts, or tests execute; that remains disabled until VM-class isolation is demonstrated.

## Test sources and evidence boundaries

This inventory describes repository test sources, not checks run for this documentation change. Test existence is not a live infrastructure result.

- `@gotchu/contracts`: assessment request/report schemas and event/runtime validation.
- `@gotchu/assessment`: fixed source rules, pinned advisory behavior, bounded HTTP evidence, comparison classifications, and unavailable/partial coverage.
- `@gotchu/demo-target`: controlled HTTP fixture behavior for vulnerable and corrected revisions.
- `@gotchu/backend` and `@gotchu/database`: tenant/RLS boundaries, operator-seeded target, assessment job admission bounds, durable report persistence, and existing event/outbox behavior. Postgres suites use isolated test services.
- `@gotchu/web`: fixed-scope demo API constraints, same-origin/body/input validation, Auth.js adapter behavior, and API routes. These sources do not establish a live OAuth-provider login.
- `@gotchu/coordinator`: assessment runner boundary, bounded execution behavior, and existing durable event/investigation processing. Local integration fixtures do not establish cloud deployment.
- `@gotchu/infra`: Pulumi resource/configuration policy under mocks only; no AWS account is contacted.
- `test/integration/assessment-demo.test.ts`: real scoped report persistence and all six mode/revision combinations using Postgres, Redis/BullMQ, the actual assessment runner and target, and the production HTTP handler behind a test-only Node bridge. Covers duplicate delivery, external independence, quotas and revoked targets.
- `test/integration/pipeline.test.ts`: the separate event-pipeline path with temporary Postgres and Redis. It does not substitute for cloud, restore, production identity, scanner, or customer-code isolation evidence.

## Local commands

Use Node 24, pnpm 11, and Docker. The controlled demo workflow is:

```sh
pnpm install --frozen-lockfile
pnpm demo:start
pnpm demo:stop
```

The root commands use `scripts/controlled-demo.mjs`. It builds the relevant packages, starts Compose Postgres and Redis, applies the operator-only demo seed, and starts the built web/coordinator processes with the inline target. Defaults bind web to loopback port 3000, coordinator to loopback port 3003, and the target to loopback port 4100. GOTCHU_DEMO_WEB_PORT and GOTCHU_DEMO_COORDINATOR_PORT override the first two ports. PID, port, log, and state records are kept under `.local/demo`. Stop only terminates the recorded web/coordinator processes. `scripts/infra-local-down.sh` separately stops data services and retains their volumes.

Workspace checks and the separate event-pipeline integration command are:

```sh
pnpm check
pnpm test:integration
```

The root `check` script builds, typechecks, and runs package tests. Integration tests require Docker and use isolated local services. See [the verification record](validation.md) for checks actually run and their limits. Do not treat Pulumi mocks or local service tests as an AWS deployment or live cloud check.

## Later release gates

| Gate | Evidence needed before claiming the capability |
| --- | --- |
| General source and dependency assessment | Runnable pinned scanners, supported repository adapters, lockfile/installed dependency scope, advisory freshness, provenance, output/resource bounds, and representative accuracy evidence. The current three-file profile is not general SAST. |
| External assessment beyond the fixture | Explicitly authorized target enrollment and ownership, a safe allowlist and network policy, broader route/protocol coverage, production transport controls, and measured limits. The demo endpoint accepts no arbitrary target. |
| Production identity and approvals | Production Auth.js configuration, tenant membership policy, a trusted fresh-second-factor verifier, replay/expiry protection, live provider validation, and negative authorization fixtures. Approval stays unavailable until then. |
| Monitoring and cloud coverage | Scoped AWS and any selected telemetry adapters, authorization and freshness behavior, alert delivery/response readiness, and verified coverage reporting. AWS infrastructure definitions alone do not provide a customer connector. |
| Model investigation | Optional provider adapter behind the gateway, external-processing opt-in, data minimization, authoritative per-run token/spend enforcement, timeouts, and unknown-outcome reconciliation. Without configuration, model requests remain unavailable and spend zero. |
| Provider writes and response | Exact action/target revalidation, trusted approvals, a separately held write adapter, durable uncertain-outcome reconciliation, and explicit authorization for each supported response mode. Severity cannot grant these permissions. |
| Customer-code execution | Demonstrated disposable VM-class isolation per job, controlled network access, bounded resources, no credentials, and independent validation. Customer dependency installation and tests remain disabled. |
| AWS deployment | Reviewable Pulumi plan, operator-controlled deployment, service installation/configuration, live health and security checks, and no claim based on mock tests alone. No deployment has occurred. |
| Restore and operations | Clean-environment restore drill, authorization reconciliation after recovery, measured load/capacity behavior, current provider pricing, and evidenced operating costs. Earlier recovery/budget figures remain proposals, not guarantees. |

The earlier accepted product requirements and the current demo scope are recorded separately in the [definition interview](definition-interview.md). Keep implementation claims tied to code and operational evidence; a reference or proposed limit is not a measured guarantee.
