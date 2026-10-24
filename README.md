# Gotchu controlled assessment demo

Gotchu currently delivers a controlled security-assessment demonstration: bounded source checks, an independent private-HTTP check, persisted evidence and comparison reports, and a minimal Spanish dashboard. The selected vulnerable and corrected applications are fictional fixtures. This is not a general SAST product or a production security service.

## What the demo does

- Runs internal, external, or combined assessment profiles against the operator-seeded Paper Moon Store fixture.
- Compares source/configuration observations with a separate HTTP response and records provenance, coverage, confidence, severity, exploitability, and limitations in each report.
- Shows persisted runs, evidence, coverage, and comparisons in the Spanish dashboard; reports can be exported as JSON.
- Operates in observation mode. The assessment does not change the target or perform response actions.

The public demo is fixed to one seeded tenant, application, and target. Requests can select only an assessment mode and the vulnerable or corrected fixture. They cannot provide a URL, path, tenant, or application. The backend permits at most three unfinished jobs and 100 lifetime jobs for this demo scope. Each web process also limits new idempotency keys to 10 per rolling minute and well-formed assessment POSTs to 30 per 60-second window. These are admission bounds, not throughput guarantees.

The assessment profile checks three fixed files with deterministic TypeScript AST/literal and configuration rules, plus one offline captured lodash advisory. The corrected fixture removes its unused lodash declaration. No code is executed, packages are not installed, and no exploit is attempted. The external profile uses one bounded GET to the configured literal loopback/private IPv4 HTTP origin; it does not need source access. A partial or missing check remains unknown coverage, and no finding is not a security verdict.

## Run locally

Use Node 24, pnpm 11, and Docker. Install dependencies once, then start the controlled demo:

```sh
pnpm install --frozen-lockfile
pnpm demo:start
```

The root demo commands use `scripts/controlled-demo.mjs`. It builds the relevant packages, starts Compose Postgres and Redis, applies the operator-only fixed demo seed, and launches the built web and coordinator processes with the inline target. Defaults bind the web UI to loopback port 3000, the coordinator to loopback port 3003, and the target to loopback port 4100. Set `GOTCHU_DEMO_WEB_PORT` or `GOTCHU_DEMO_COORDINATOR_PORT` to override the first two ports. Process IDs, ports, logs, and state are recorded under `.local/demo`.

Stop the recorded web and coordinator processes with:

```sh
pnpm demo:stop
```

That command leaves Postgres, Redis, and their volumes running. `scripts/infra-local-down.sh` stops the data services while retaining their volumes.

For workspace checks and the existing event-pipeline integration path, use `pnpm check` and `pnpm test:integration`. The latter requires Docker. See [the verification record](docs/validation.md) for the checks actually run and their limits.

## Architecture and boundaries

The web application uses TanStack Start and Auth.js Core. Auth.js can be configured with a generic HTTPS OIDC issuer or GitHub OAuth sign-in; neither provider is mandatory, and live OAuth has not been demonstrated. Sign-in is not repository access. The public assessment demo uses its fixed public demo identity and exposes only demo-scoped operations.

Customer business data remains behind tenant authorization and Postgres row-level security. The public demo reads and writes only the operator-seeded demonstration scope; its reports describe fictional fixture data. AWS is the primary deployment target. Pulumi currently describes two EC2 instances and private S3 storage, and its policy tests use mocks; no AWS deployment has been made. Core workflows use replaceable adapters and open contracts, so GitHub, a model API, an OIDC vendor, or any paid external service is not required to run the assessment.

See [the current architecture](docs/architecture.md), [implementation status and release gates](docs/implementation-plan.md), [the architecture overview](docs/architecture-overview.html), and the [definition interview](docs/definition-interview.md), which preserves the earlier product decisions and records the current demo direction.
