# Implementation status and release gates

## Current stage

The current product is an authenticated local application for source/public HTTPS assessment, selected-input periodic monitoring, signed runtime alerts and exact private correction preparation. Its usable customer path includes local account registration and sign-in, workspace creation/listing, application create/list/rename/archive/restore, source snapshot upload/deletion, DNS TXT target verification/expiry/revocation, queued assessments in three modes, and persisted evidence-backed reports.

The fictional vulnerable/corrected application is a regression fixture only. The customer flow does not depend on a demo seed, fixture tenant, or fixture revision. The development runtime is local only; AWS is the planned primary hosting target, and no cloud deployment has occurred.

For the detailed next-stage backlog, dependencies, acceptance checks, and evidence-based comparison with Snyk/Aikido, see the [autonomous defense and differentiation plan](plan-defensa-autonoma.md). Its proposed capabilities remain pending; this document records implemented behavior and release gates.

## Implemented customer path

| Area | Present behavior | Current boundary |
| --- | --- | --- |
| Identity | Auth.js session handling with local Credentials and configured WebAuthn step-up factors. Users can enroll/rename/revoke up to ten user-scoped factors, use one-time recovery codes to add a factor or revoke one, and request a single-use proof bound to an organization and exact action hash. First-factor bootstrap requires local-password reauthentication; subsequent enrollment requires a fresh fixed-action proof or recovery code. Sign-out invalidates pending challenges and proofs. | Local registration requires `NODE_ENV=development` plus an explicit flag. Step-up is separate from sign-in and is not wired to an approval UI. Challenges and proofs also expire within two minutes. The browser ceremony uses an opt-in Playwright CDP virtual authenticator against disposable Postgres; production identity configuration remains unvalidated. |
| Workspaces and applications | Authenticated users create/list workspaces; a creator is Owner. Owners invite by email, grant Owner/Operator/Viewer roles, revoke pending invites, and remove members; Operators and Viewers can leave. Workspace members and invitations are bounded, audited, tenant-scoped, and enforced in PostgreSQL. Applications can be created, listed, renamed, archived, and restored. Backend transactions check membership; Owner/Operator roles can write, Viewer can read. | Invites expire after 7 days and are single-use; at most 50 are pending, 20 are created per day, and 100 members are allowed. Local accounts do not verify email ownership, so matching the account email is defense in depth rather than proof of mailbox control. Email delivery and workspace deletion are not available. Archived applications reject new assessment changes until restored. |
| Source snapshots | Upload normalized snapshots to an application, retain a canonical digest, list active snapshots, and delete snapshots when no queued/running request depends on them. | Up to 4 MiB serialized, 1,000 files, 1 MiB per file, ten active snapshots per app, and 100 new snapshots per workspace/day. Supported paths are relative JS/TS, JSON, YAML, and TOML. Operator-scoped bare Git/GitHub capture is also supported. No package install, customer script, build, test, or code execution. |
| HTTPS authorization | Customer-declared public HTTPS origin, explicit authorization, a random DNS TXT challenge at `_gotchu.<hostname>`, and target-specific verify/revoke lifecycle. | Challenge lasts 30 minutes; verified authorization lasts seven days. Each app has one target. Root consent permits one GET to `/`; explicit public-surface consent permits bounded same-origin paths/discoveries. No arbitrary caller URL, credentials, redirects or exploitation. |
| Assessment requests | `internal` requires a source snapshot; `external` requires a verified target and no source; `both` requires both. Durable request/outbox intent is stored before coordinator processing. | At most three unfinished requests per app and 20 requests per workspace per day. These are admission bounds, not throughput or service-level guarantees. |
| Scanner service | Separate HMAC-authenticated service called by the coordinator. Fixed Semgrep CE 1.90.0, Gitleaks 8.28.0, and Trivy 0.67.2 profiles parse uploaded bytes; optional OSV-compatible queries inspect exact package-lock names/versions. | Semgrep 1.90.0 is enforced development/test-only. Production execution and green aggregate readiness are blocked until a maintained profile is pinned and validated. Parser containers are not VM-class isolation. |
| External transport | Re-resolves and validates public DNS answers, pins an allowed address, verifies target TLS and hostname, and bounds response size/deadline. | Only the enrolled origin and exact consented profile are checked. Missing evidence, failed transport or capped/unsupported coverage remains unknown. |
| Reports | Persisted per organization/application with subject binding, source/target version, evidence checksums and provenance, coverage, limitations, findings, and internal/external comparison. | Missing coverage is unknown, not clean. Package matches and response indicators do not prove reachability, deployment equivalence, exploitation, or compromise. Exploitability remains unclaimed. Reports are observational and do not authorize actions. |
| Local services | Web on loopback port 3000, coordinator on 3003, scanner on 4400, with local Postgres and Redis. Processes are recorded under `.local/dev`; customer data remains in local persistent service volumes. | No cloud service, production TLS ingress, restore guarantee, measured capacity, or cloud security claim. The launcher seeds no customer or demo workspace. |

## Architecture and boundaries

TanStack Start adapts HTTP requests to Auth.js and framework-independent backend services. The authenticated server session supplies the user identity; client-provided organization/application IDs are selectors, not authorization. Membership checks and Postgres row-level security scope customer operations. The API writes only its allowed database role.

Postgres is the authority for assessment requests, leases, source snapshots, and reports. The outbox feeds Redis/BullMQ, and the independent coordinator claims work. It passes the durable request to the separate scanner service over the signed HTTP boundary. The scanner has no database or Redis access. It returns a contract-validated report; the backend rechecks lease, source digest, and target authorization before committing report and job completion.

The internal and external profiles run independently. Internal scanning is source-only and never executes customer code. External assessment can run without any source upload. `both` combines their evidence while preserving which observations came from each profile. Unknown coverage is retained in the report and is never converted into a clean result.

Target renewal/revocation waits for settled work: queued/running requests return 409 without changing authorization. An uncertain scanner/transport outcome or reclaimed customer delivery is quarantined for trusted operator reconciliation, rather than automatically rescanned. That quarantine continues to block target changes after the job is marked failed; no customer HTTP escape is exposed.

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
| Models and response readiness | Selected-input monitoring, scoped repository adapters, signed telemetry and in-app alerts are implemented. External notification delivery, responder escalation, customer model opt-in and live model/provider workflows remain unavailable. |
| Capacity and service guarantees | Measure representative accuracy, service capacity/latency, recovery, and operating costs under the intended hosted environment. Local bounds and successful tests are not production guarantees. |

See the [architecture](architecture.md), [architecture overview](architecture-overview.html), [local development instructions](development.md), and [historical product decisions and correction](definition-interview.md#current-user-correction-actual-customer-application-in-development). Keep capability claims tied to implementation and operational evidence.

## Monitoring and correction milestone

Implemented: persisted monitor configuration/runs/leases, scoped operator repository catalogs, exact Git/GitHub snapshots, repeat OSV metadata checks, Cloudflare/Railway public status context, explicitly consented bounded public discovery, signed telemetry key lifecycle, versioned runtime detectors, independent report-alert delivery, private alert triage and revision-bound advisory plans.

Supported exact TLS/configuration corrections create separate private source candidates and atomic rescan jobs. Context and findings select versioned recipes; there is no model-generated arbitrary command execution. The original repository and production remain untouched. Dependency upgrades, credential rotation, broad source rewrites and provider actions require additional adapters/validation.

## Application context inventory

Implemented in migrations 014 and 016: tenant-scoped environments, services, repository links restricted to the configured repository catalog, deployments, dependency relations, and origin candidates. Writes are limited to owners/operators, audited, rejected for archived applications/environments, and bounded per application/environment. Customer declarations always remain `declared` with source `customer_declared`; customer requests cannot set `verified`, `operator`, or `signed_telemetry`. Repository read access follows catalog membership and becomes revoked on revoke; write access remains `not_granted`. Origin ownership is accepted only as `unknown` or `claimed`; `verified` is derived at read time while its linked target is DNS-verified and unexpired. An origin candidate does not authorize assessment. Signed event attributes may include bounded release, service, dependency, and templated route values. These attributes are not yet materialized into deployment rows because event labels alone do not identify a verified service or prove deployment contents. Analyzed versus deployed identity is shown as match/difference only for verified deployment state with a shared commit or source digest; otherwise it remains unknown.

Monitoring shares finite assessment/source admission and has retained-run/observation/plan bounds. Operator retention maintenance is still required. In-app alerts are not email delivery or guaranteed continuous coverage. Provider status evidence has unverified application impact. Actual setup and button behavior are documented in [operations](operations.md); test results belong in [validation](validation.md).

## Incident triage milestone

Implemented locally: tenant/application-scoped incidents and immutable, digest-deduplicated triage revisions; coordinator evaluation after signed-event aggregation; verified/declaration-aware context passed to the deterministic correlator; owner/operator incident status with audit; and a Spanish incident card with impact, hypotheses, evidence, unknowns, and revision history. Grouping selects the latest non-closed incident for an application/environment with evidence in the prior two hours; after two quiet hours a later evaluation opens a new incident. User closure immediately removes that incident from grouping and affects triage status only, never inferred impact.

Current integration gap: operational metric observations and application context feed the adapter. Existing metric projections lack service/environment labels, so those signals remain app-level. Provider component scope/fixture metadata and HTTPS route outcomes are not stored in a structured triage source yet, so the adapter leaves those feeds absent instead of inferring health. Evidence requests only advance the due time of the already-enabled monitor; they do not add targets or report execution completion. D03 end-to-end demo scenarios and full D15 evaluation remain pending until these source paths and their live checks are implemented.
