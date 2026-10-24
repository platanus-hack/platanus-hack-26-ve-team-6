# Implementation status and release gates

## Current stage

The current product is an authenticated customer application for locally run source and public HTTPS assessments. Its usable customer path includes local account registration and sign-in, workspace creation/listing, application create/list/rename/archive/restore, source snapshot upload/deletion, DNS TXT target verification/expiry/revocation, queued assessments in three modes, and persisted evidence-backed reports.

The fictional vulnerable/corrected application is a regression fixture only. The customer flow does not depend on a demo seed, fixture tenant, or fixture revision. The development runtime is local only; AWS is the planned primary hosting target, and no cloud deployment has occurred.

## Implemented customer path

| Area | Present behavior | Current boundary |
| --- | --- | --- |
| Identity | Auth.js session handling with a local Credentials provider for email/password. Local registration is exposed by the development launcher. | Registration requires `NODE_ENV=development` plus an explicit flag. Password operations and attempts are bounded. Production MFA and verified second-factor approval are unavailable. Live OIDC/GitHub configuration is not claimed. |
| Workspaces and applications | Authenticated users create/list workspaces; a creator is Owner. Applications can be created, listed, renamed, archived, and restored. Backend transactions check membership; Owner/Operator roles can write, Viewer can read. | No workspace invite, member-management, or workspace-delete flow. Archived applications reject new assessment changes until restored. |
| Source snapshots | Upload normalized snapshots to an application, retain a canonical digest, list active snapshots, and delete snapshots when no queued/running request depends on them. | Up to 4 MiB serialized, 1,000 files, 1 MiB per file, ten active snapshots per app, and 100 new snapshots per workspace/day. Supported paths are relative JS/TS, JSON, YAML, and TOML. No repository clone, package install, customer script, build, test, or code execution. |
| HTTPS authorization | Customer-declared public HTTPS origin, explicit authorization, a random DNS TXT challenge at `_gotchu.<hostname>`, and target-specific verify/revoke lifecycle. | Challenge lasts 30 minutes; verified authorization lasts seven days. Each app has one target. Assessment performs one bounded GET to `/` at the verified origin; no caller-controlled URL/path, credentials, redirects, retries, broad route scan, or exploitation. |
| Assessment requests | `internal` requires a source snapshot; `external` requires a verified target and no source; `both` requires both. Durable request/outbox intent is stored before coordinator processing. | At most three unfinished requests and 20 requests per app per day. These are admission bounds, not throughput or service-level guarantees. |
| Scanner service | Separate HMAC-authenticated service called by the coordinator. Fixed Semgrep CE 1.90.0, Gitleaks 8.28.0, and Trivy 0.67.2 profiles parse uploaded bytes; optional OSV-compatible queries inspect exact package-lock names/versions. | Semgrep 1.90.0 is enforced development/test-only. Production execution and green aggregate readiness are blocked until a maintained profile is pinned and validated. Parser containers are not VM-class isolation. |
| External transport | Re-resolves and validates public DNS answers, pins an allowed address, verifies target TLS and hostname, and bounds response size/deadline. | Only the enrolled root origin is checked. Missing response evidence, failed transport, or unsupported coverage remains unknown. |
| Reports | Persisted per organization/application with subject binding, source/target version, evidence checksums and provenance, coverage, limitations, findings, and internal/external comparison. | Missing coverage is unknown, not clean. Package matches and response indicators do not prove reachability, deployment equivalence, exploitation, or compromise. Exploitability remains unclaimed. Reports are observational and do not authorize actions. |
| Local services | Web on loopback port 3000, coordinator on 3003, scanner on 4400, with local Postgres and Redis. Processes are recorded under `.local/dev`; customer data remains in local persistent service volumes. | No cloud service, production TLS ingress, restore guarantee, measured capacity, or cloud security claim. The launcher seeds no customer or demo workspace. |

## Architecture and boundaries

TanStack Start adapts HTTP requests to Auth.js and framework-independent backend services. The authenticated server session supplies the user identity; client-provided organization/application IDs are selectors, not authorization. Membership checks and Postgres row-level security scope customer operations. The API writes only its allowed database role.

Postgres is the authority for assessment requests, leases, source snapshots, and reports. The outbox feeds Redis/BullMQ, and the independent coordinator claims work. It passes the durable request to the separate scanner service over the signed HTTP boundary. The scanner has no database or Redis access. It returns a contract-validated report; the backend rechecks lease, source digest, and target authorization before committing report and job completion.

The internal and external profiles run independently. Internal scanning is source-only and never executes customer code. External assessment can run without any source upload. `both` combines their evidence while preserving which observations came from each profile. Unknown coverage is retained in the report and is never converted into a clean result.

AWS is the intended first hosting provider, while core domain contracts and adapters remain replaceable. Infrastructure definitions or local service tests are not evidence of a live AWS deployment.

## Test sources and evidence boundaries

The repository includes `test/integration/customer-applications.test.ts`, which starts built web and coordinator processes with real local PostgreSQL and Redis services. It exercises Auth.js local registration/session, tenant and application isolation, snapshots, the HMAC scanner HTTP boundary, the DNS TXT authorization lifecycle, target revocation, queued work, and persisted reports. The protocol path deliberately injects unavailable scanner adapters so missing tools become unknown coverage rather than fabricated findings. The file also has an explicit opt-in path for actual pinned Docker scanners, OSV queries, and local TLS. Test source is evidence of an available check, not a claim that the check ran for this documentation update or that production/cloud behavior is proven.

Other relevant source contracts include `packages/contracts/src/customer-assessment.ts`, `packages/backend/src/customers.ts`, `apps/web/src/server/customer-api.ts`, `apps/web/src/server/local-accounts.ts`, `apps/web/src/server/auth.ts`, `apps/coordinator/src/jobs.ts`, and `packages/customer-assessment/README.md`. The customer integration path requires prepared package outputs and disposable local data services; the opt-in scanner path additionally requires pinned Docker images and OSV access.

## Local commands

The customer development launcher uses Node 24, pnpm 11, Docker, and `scripts/development.mjs`:

```sh
pnpm dev:prepare
pnpm dev:start
pnpm dev:stop
```

`dev:prepare` prepares the pinned local scanner and data-service images. `dev:start` builds the required packages, checks local configuration and image availability, starts Postgres/Redis, and then starts web, coordinator, and scanner after readiness succeeds. It creates no customer or demo seed. `dev:stop` stops only the recorded application processes; local data services and persistent volumes remain. Use [local development instructions](development.md) for preparation requirements, configuration, port overrides, and data-service shutdown.

Workspace checks, integration runs, and their actual results are tracked in the [verification record](validation.md). Do not treat a test source or mock test as a test run, live AWS check, production scanner validation, recovery drill, or service guarantee.

## Later release gates

| Gate | Evidence required before enabling or claiming it |
| --- | --- |
| Production source scanning | Replace the development/test-only Semgrep 1.90.0 pin with a maintained pinned profile. Validate scanner accuracy, coverage behavior, throughput/resource bounds, advisory freshness, and readiness in the production runtime. |
| Customer-code execution | Demonstrate disposable VM-class isolation per job, controlled network access, bounded resource/lifetime, no provider or production credentials, and independent validation. Current parser containers do not satisfy this gate. |
| Production transport | Provide and validate TLS ingress for web and scanner services, secure secret provisioning, and production network policy. The local launcher binds services to loopback; target HTTPS checks do not establish service-ingress TLS. |
| Identity and workspace management | Configure and validate production authentication, MFA/step-up controls, workspace invitations, and member management. Local Credentials registration is development-only. |
| Durable recovery and operations | Implement backup/restore, reconcile in-flight work and authorization after restore, and complete a clean-environment recovery drill. Local Postgres/Redis persistence is not disaster-recovery evidence. |
| AWS hosting | Review and apply an operator-approved deployment, then run live AWS health/security checks. No AWS deployment has occurred. |
| Provider writes and response | Implement independent write adapters, exact action/target revalidation, trusted approvals, durable uncertain-outcome handling, and separate response-mode authorization. Assessments currently perform no changes. |
| Monitoring, integrations, and models | Implement scoped customer connectors, event delivery/readiness, alerts, external-processing opt-in, authoritative model budgets, and response readiness. Existing event, investigation, and executor foundations do not expose these as working customer assessment capabilities. |
| Capacity and service guarantees | Measure representative accuracy, service capacity/latency, recovery, and operating costs under the intended hosted environment. Local bounds and successful tests are not production guarantees. |

See the [architecture](architecture.md), [architecture overview](architecture-overview.html), [local development instructions](development.md), and [historical product decisions and correction](definition-interview.md#current-user-correction-actual-customer-application-in-development). Keep capability claims tied to implementation and operational evidence.
