# Gotchu

Gotchu combines security assessments, continuous selected-input monitoring and evidence-backed correction preparation. Customers manage private workspaces, inspect authorized source and HTTPS applications, receive in-app alerts, and prepare supported corrections through the dashboard. The current runtime is local development.

The fictional vulnerable and corrected applications are regression fixtures only. They are not the product, are not seeded by the customer-development launcher, and do not limit customer assessments. The current product runs locally in development; no cloud deployment is claimed.

## Customer workflows

- Auth.js authenticates customer sessions. The local development launcher enables email/password registration without an OAuth provider; registration is only enabled when `NODE_ENV=development` and the explicit local-registration flag is set.
- Users create and list workspaces. A workspace creator becomes its Owner. Applications can be created, listed, renamed, archived, and restored within a workspace. Membership roles scope access; Owners and Operators can change applications and assessment inputs, while Viewers have read access.
- Customers upload immutable source snapshots, or select an operator-authorized local Git/GitHub repository for periodic capture at an exact commit. Source deletion is supported when no queued/running assessment depends on it. No source, package scripts or customer tests are executed.
- An Owner or Operator can enroll a public HTTPS origin after explicitly confirming authorization. The customer adds the issued TXT value at `_gotchu.<hostname>`; successful verification authorizes that application's origin for seven days. The customer can revoke it sooner. The external check uses the authorized origin, not a caller-supplied URL or path.
- An assessment can inspect a source snapshot (`internal`), an authorized HTTPS target (`external`), or both. External-only assessment does not require source access. Jobs and reports are tenant-scoped and persisted.
- Explicit `public_surface` consent expands the root check to bounded same-origin public paths and discoveries. It never grants access to every domain or asset belonging to a company.
- **Vigilancia** configures scheduled source/target checks and optional Cloudflare/Railway status feeds. Repository changes and current npm advisory metadata can produce alerts; unchanged commits are checked again for new advisories. Operator-scoped repository setup is required.
- Signed application events produce grouped alerts for observed errors, service pressure and supported suspicious activity. A busy but healthy API does not automatically produce an attack or load-balancer recommendation.
- Versioned correction recipes select options from actual findings and literal repository context. Supported exact TLS/configuration candidates create a new private snapshot and queue an independent rescan. Capacity/migration plans provide guided preparation and show missing requirements. Provider writes and production deployment remain disabled.

Reports retain evidence provenance and checksums, scanner coverage, severity, confidence, exploitability, limitations, and internal/external comparisons. Missing or partial coverage remains unknown, not clean. A match, response header, or correlation does not prove that source is deployed, that a package is reachable, or that exploitation occurred. The assessment does not attempt exploitation or make exploitability claims.

## Run locally

Use Node 24, pnpm 11, and Docker. After preparing the local dependencies, start the customer application:

```sh
pnpm install --frozen-lockfile
pnpm dev:prepare # only when pinned images are missing
pnpm dev:start
```

Open http://127.0.0.1:3000/dashboard. Registration is enabled in this local development runtime, and no account, workspace, application, or assessment target is pre-created.

The launcher runs the web application on port 3000, the coordinator on port 3003, and the separate scanner service on port 4400. The web, coordinator, and scanner ports can be overridden with `GOTCHU_DEV_WEB_PORT`, `GOTCHU_DEV_COORDINATOR_PORT`, and `GOTCHU_DEV_SCANNER_PORT`. Postgres and Redis run as local data services with persistent local volumes. The launcher records app process IDs, ports, logs, and local scanner credentials under `.local/dev`; it does not create a demo seed. `pnpm dev:stop` stops the recorded app processes and leaves Postgres, Redis, and their data volumes running.

The development launcher uses actual bounded scanner profiles. Semgrep 1.90.0 is enforced as development/test-only; production scanner use is blocked until that profile is replaced and validated. Read [local development instructions](docs/development.md) for preparation requirements and lifecycle details. See [architecture](docs/architecture.md), [implementation status and release gates](docs/implementation-plan.md), and the [architecture overview](docs/architecture-overview.html).

## Product and release boundaries

The core flow uses shared contracts and replaceable adapters, with AWS as the eventual primary hosting target. The current local runtime is not an AWS deployment. Production scanner upgrades, customer-code VM isolation, production TLS termination, recovery evidence, provider writes, production MFA, and workspace invitation management remain unavailable or unproven. No response action is taken by an assessment.

The repository contains customer-flow integration coverage in `test/integration/customer-applications.test.ts`. Its live path uses local Postgres and Redis, built web and coordinator processes, a signed scanner HTTP boundary, a controlled DNS TXT fixture, and local TLS. Real Docker scanner and OSV checks are an explicit opt-in in that integration file. Test sources describe what can be exercised; they are not a claim that those checks were run for this documentation update or that cloud behavior is proven.

Earlier product decisions and the subsequent correction that the customer application is the product are preserved in the [definition interview](docs/definition-interview.md#current-user-correction-actual-customer-application-in-development).

See [monitoring, alerts and correction setup](docs/operations.md) for the working paths, evidence boundaries and admission limits. In-app alerts do not imply delivered email, continuous third-party repository-source auditing, proven exploitation or completed production recovery.

The [autonomous defense and differentiation plan](docs/plan-defensa-autonoma.md) audits the remaining gaps and defines staged work for application-impact triage, independently validated corrections, authorized PRs and delivery, and later response capabilities. It is a roadmap, not a list of available features.
