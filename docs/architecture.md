# Gotchu customer application architecture

Gotchu's current product combines authenticated source/public HTTPS assessments, scoped periodic monitoring, signed runtime alerts and exact private correction preparation. Customers manage their own workspaces and applications, submit source snapshots, verify authorized HTTPS origins, and review persisted evidence-backed reports. The fictional vulnerable/corrected application is a regression fixture only; customer assessments accept customer-provided snapshots and verified targets.

The customer runtime is currently local development. AWS is the eventual primary hosting target, with portable contracts and replaceable adapters. The production-mode scanner and coordinator completed local TLS assessment and durable database-backed work after CA certificate canonicalization on Linux/amd64. This is not a cloud deployment or a production-service guarantee; see the [verification record](validation.md) for the exercised scope and limits.

## Customer assessment flow

```mermaid
flowchart LR
  customer[Customer dashboard]
  auth[Auth.js session<br/>local credentials in development]
  web[TanStack Start<br/>customer API]
  backend[@gotchu/backend<br/>membership and scope checks]
  pg[(Postgres<br/>workspace, source, job, report)]
  redis[(Redis / BullMQ<br/>job delivery)]
  coordinator[@gotchu/coordinator<br/>durable job worker]
  scanner[@gotchu/scanner<br/>separate HMAC service]
  engine[@gotchu/customer-assessment<br/>bounded profiles]
  tools[Semgrep · Gitleaks · Trivy<br/>optional OSV advisory lookup]
  target[DNS-verified public HTTPS origin]

  customer --> auth --> web --> backend
  backend -->|transactional request and outbox| pg
  pg --> redis --> coordinator
  coordinator -->|exact durable request · HTTP/HMAC in loopback dev; HTTPS/HMAC in production| scanner --> engine
  engine -->|uploaded source only| tools
  engine -->|independent consented HTTPS profile| target
  engine -->|validated report| scanner
  scanner -->|bounded result| coordinator
  coordinator -->|atomic report and job completion| backend
  pg --> backend --> web --> customer
```

The web request authenticates through Auth.js and derives identity from the server-side session. The customer API uses same-origin checks on writes and passes only validated inputs to framework-independent backend services. Tenant membership is checked in the database transaction; Postgres row-level security and separate runtime roles provide additional boundaries. Owners and Operators can change application assessment inputs; Viewers can read customer data.

The backend stores assessment intent and a durable outbox record in one transaction. The coordinator claims work using the persisted job lease, reads the exact source/target version, and calls the independent scanner service. Redis/BullMQ transports work but does not authorize it. The scanner has no database or Redis access. Results are revalidated against the durable request and lease before the report and job completion are committed together. A revoked, expired, or changed target prevents queued work from making the HTTPS request or completing as authorized.

## Customer records and authorization

### Accounts and workspaces

Auth.js owns session handling. The development runtime enables a Credentials provider backed by local email/password accounts; passwords use a bounded scrypt profile and authentication attempts are rate-limited. Registration is enabled in production only by explicit `GOTCHU_AUTH_MODE=public`, or in development by the existing opt-in flag. Public signup creates an account without existing workspace memberships; private `self_host` mode retains its one-use Owner setup and disables open registration. Local sign-in can be configured outside development; see the [AWS runtime](../infra/aws/README.md) for hosted checks and remaining operational limits. No OAuth provider is required for local development. OIDC and GitHub OAuth can be configured as Auth.js providers, but no live production identity configuration is claimed. WebAuthn factor enrollment, recovery codes, and action-bound step-up proofs are implemented; step-up is not a general approval path and its production lifecycle has not been validated.

New accounts start without a seeded workspace. A user can create and list workspaces; the creator receives the Owner role. The current customer API supports application create/list, rename, archive, and restore operations. Workspace invitations and member-management operations are implemented and tenant-scoped: Owners can invite, change roles, and remove members; Operators and Viewers can leave. Email delivery and production identity validation remain open. Archived applications cannot accept new sources or assessments until restored.

### Source snapshots

Customers submit normalized source snapshots directly to an application. The shared contract allows up to 4 MiB serialized per snapshot, 1,000 files, and 1 MiB per file; paths are restricted to supported relative JS/TS, JSON, YAML, TOML, and recognized lockfile paths. The backend sorts files, calculates a canonical digest, deduplicates active identical snapshots, and stores source bytes in Postgres. No repository provider is required.

This is a bounded source-file profile, not whole-application or all-language coverage. Exact dependency inventory recognizes npm `package-lock.json` v2/v3, pnpm `pnpm-lock.yaml` v6/v9, Yarn classic v1, and Yarn Berry. Parser size, entry, depth, package, and graph bounds are explicit; malformed, capped, and unsupported lockfiles remain unknown. No packages are installed and no customer code runs. The optional bounded OSV adapter sends only package names and exact versions.

License metadata comes from a lockfile declaration when present or the npm registry's exact-version license field. SPDX expressions are normalized and evaluated against a tenant-scoped workspace policy managed by Owners and Operators. Strong copyleft and unknown declarations default to review. Reports preserve the source path and license metadata provenance; declarations are not verified against package contents and do not establish legal compliance. Each persisted source assessment can export CycloneDX 1.5 from its recorded inventory; partial lockfile or dependency graph coverage is marked incomplete. The report UI provides inventory filters, policy status, and SBOM download.

Owners and Operators can delete a snapshot. Deletion clears its stored body and hides the snapshot from active lists, but is rejected while a queued or running job depends on it. Assessments recheck that the stored snapshot still matches the durable digest. Customer code, package scripts, package installation, builds, and customer tests are never run.

### Authorized public HTTPS targets

Enrollment accepts a canonical public HTTPS origin only: a DNS hostname, no credentials, path, query, fragment, or custom port. The customer must affirm authorization and prove DNS control by publishing the issued random TXT challenge at `_gotchu.<hostname>`. The challenge expires after 30 minutes. Successful verification records the actor and time and authorizes the target for seven days. Customers can revoke authorization sooner; enrolling again creates a new version. Only one target is active for an application.

At scan time, the trusted HTTPS transport resolves the hostname again, rejects nonpublic or reserved answers, pins a validated public IP, verifies the certificate and original hostname, and honors the target's expiration deadline. It sends no customer credentials or cookies, does not follow redirects, and uses the exact consented profile. Root consent permits one GET to `/`; `public_surface` permits up to ten serial GETs to `/`, `/.well-known/security.txt`, `/security.txt`, `/robots.txt`, `/sitemap.xml`, and safe query-free same-origin links from readable HTML/robots/sitemap responses. It waits 250 ms between requests, reads at most 64 KiB total and 16 KiB per response. It does not execute JavaScript or discover subdomains. It may GET safe discovered same-origin public paths; it performs no authenticated or state-changing API exercise or API introspection. DNS, TLS, scope, cap or deadline failures remain unknown coverage. External assessment needs no source snapshot.

## Assessment modes and reports

The request contract binds source and target inputs to the selected mode:

| Mode | Source snapshot | Verified HTTPS target |
| --- | --- | --- |
| `internal` | Required | Not used |
| `external` | Not used | Required |
| `both` | Required | Required |

The internal and external branches collect evidence independently. Internal work uses bounded parsers against uploaded bytes. The pinned scanner profile includes Semgrep CE 1.182.0, Gitleaks 8.28.0, Trivy 0.67.2, and an optional OSV lookup over supported exact-version npm lockfile entries. It does not inspect installed packages or prove reachability. The OSV adapter sends package names and exact versions only. The production-mode scanner completed local Linux/amd64 TLS-to-durable-report checks with the pinned Docker profiles after CA certificate canonicalization. This validates the exercised runtime path, not general accuracy or capacity; source-format coverage remains deliberately limited. See the [verification record](validation.md) for detailed evidence.

### Deterministic scanner pipeline

Each invocation in `@gotchu/customer-assessment` compiles and invokes this LangGraph sequence:

```text
START -> validate -> analyze -> compare -> finalize -> END
```

`validate` parses the run contract and verifies the uploaded source digest. `analyze` starts the requested internal and external branches together, waits for both to settle, and leaves an unrequested branch absent. A private invocation closure holds that run's input and intermediate analyses; graph state exposes only stage counters. `compare` groups findings with the same correlation key. If the opposite analysis was not requested, unavailable, or partial without a matching finding, the item remains unverified; even a match does not imply deployment equivalence or exploitability. A shared CSP group can correlate source and HTTPS observations of the same control while keeping each observation's evidence and uncertainty separate. The group does not claim one issue, deployment, cause, or exploit, and one-sided unknown coverage is not absence. `finalize` validates the report and binds its tenant, application, job, source/target subject, and evidence references. The graph has no checkpointer, retry policy, or source checkpoints. Scanner execution, job leases, failure quarantine, and report persistence are handled by the surrounding services.

Manual, scheduled, and correction-rescan assessments use the same durable assessment lane and scanner runner. Signed telemetry intake, scheduling, outbox delivery, lease claims, tenant authorization, approvals, and the independent provider-write executor remain outside this graph. Private source and payloads stay in the local invocation. The deterministic scan needs no model key and makes no model call; it fails closed before scan work if LangSmith/LangChain tracing or verbose mode is enabled. The separate optional model-investigation path remains unavailable when unconfigured. The scanner does not write to customer providers.

The Helmet CSP correlation candidate is deliberately narrow: it accepts only two fixed Semgrep rule IDs, then parses JavaScript/TypeScript with TypeScript 5.9.3 `createSourceFile`. It performs no module resolution, transpilation, or code execution. A candidate needs a unique value import, the matching call location, and a literal configuration; conservative whole-file conflict checks filter ambiguous or conflicting files. This gate supports control-level correlation and is not proof of a vulnerability or runtime behavior.

For `public_surface`, reports derive path-specific missing CSP, HSTS, and `X-Content-Type-Options` observations only from complete TLS-verified responses. A returned `Server` or `X-Powered-By` banner is an informational, unverified technology indication. Response bodies are used only for inert same-origin discovery and are discarded; cookies and credentials are neither sent nor retained. These observations do not prove software identity, vulnerability, or exploitation.

Reports bind organization, application, job, source ID/digest, and target ID/version/origin. They persist bounded evidence excerpts with checksums, scanner and transport provenance, limitations, findings, coverage states, and internal/external comparisons. Coverage distinguishes inspected, unavailable, unsupported, and not-requested capabilities. Missing or partial coverage remains unknown. Lack of a finding is not a clean assessment. Findings do not claim exploitability; there is no exploitation, deployment equivalence, or compromise proof.

The report UI lists observed HTTPS responses even when no findings were derived, shows finding presence separately from cross-perspective verification, and renders unknown exploitability as unknown. The incident list and visible incident details poll every ten seconds while the page remains visible, so new incidents and revisions appear without a manual reload.

Assessments are observation-only. The report records no performed actions. Severity never expands permissions. Exact approval, bounded preauthorized automation, provider writes, recovery, and automatic response are separate capabilities and are not enabled by this customer assessment flow.

Admission is bounded in the current backend: at most three unfinished assessments per application and 20 assessments per workspace per day; source storage is capped at ten active snapshots per application and 100 new snapshots per workspace per day. These are admission controls, not throughput, latency, or production-capacity guarantees.

Renewal and revocation return `409 target_assessment_in_progress` while the target has queued/running work. Authorization remains active on that response. Unknown scanner outcomes and reclaimed customer deliveries require operator reconciliation and also block those mutations; a timeout is not proof that the scanner stopped. No customer endpoint clears that quarantine. Successful revocation is acknowledged only after outstanding work has settled or an operator has established quiescence and reconciled it.

## Local runtime

The customer development launcher starts the web app on `127.0.0.1:3000`, the coordinator on `127.0.0.1:3003`, and the scanner service on `127.0.0.1:4400` by default. Ports can be overridden with `GOTCHU_DEV_WEB_PORT`, `GOTCHU_DEV_COORDINATOR_PORT`, and `GOTCHU_DEV_SCANNER_PORT`. It starts local Postgres and Redis data services, builds the required packages, and starts the services after their readiness checks pass. It does not seed the fictional target or create customer accounts/workspaces. In this local launcher the scanner uses HTTP on loopback; the standalone scanner entry point requires TLS in `NODE_ENV=production` and supports a coordinator-scoped CA for HTTPS.

Postgres, Redis, and their volumes are local development data. `pnpm dev:stop` stops only the recorded app processes; data services remain available until separately stopped. The launcher stores process records, logs, and the scanner credential under `.local/dev`. See [local development instructions](development.md) for the complete lifecycle.

The scanner engine runs fixed, digest-pinned Docker parser images without network access, as a nonroot user, with bounded CPU, memory, process count, output, and wall time. These containers parse uploaded data; they are not a demonstrated VM-class isolation boundary. The scanner service can terminate TLS itself; the coordinator's optional private CA is scoped to that scanner client and requires an HTTPS scanner origin. The current local launcher still uses loopback HTTP. External assessment independently uses verified HTTPS to the enrolled target. The controlled DNS/TLS fixture validates this transport path; no live customer-owned domain DNS proof is claimed.

## Portability and release gates

Core contracts and service ports are independent of AWS. AWS remains the planned primary hosting target, and no deployment or live AWS validation has been performed. Production requirements remain open, including:

- extend representative accuracy, resource-bound, and readiness validation for the maintained Semgrep 1.182.0 profile across the supported input set, architectures, and intended hosted runtime;
- demonstrate disposable VM-class isolation before enabling any customer-code execution;
- provide and validate hosted TLS ingress for the web app, cloud network policy, and production secret/certificate lifecycle; scanner TLS termination and scoped coordinator CA trust are implemented and locally exercised;
- define and demonstrate backup, restore, and authorization reconciliation;
- validate production identity-provider configuration and the WebAuthn step-up/recovery lifecycle; invitation and member-management APIs exist, but email delivery and hosted operation are not validated;
- add independent provider-write adapters and exact approval semantics before any provider changes.

Customer monitoring and in-app alerts now use the durable event and assessment paths. Model investigation, external notifications, provider writes and recovery still have separate unavailable release gates. See [implementation status and gates](implementation-plan.md), the [architecture overview](architecture-overview.html), and the [historical product decisions and correction](definition-interview.md#current-user-correction-actual-customer-application-in-development).

## Continuous selected-input monitoring and correction preparation

An operator-scoped local Git/GitHub catalog binds every repository key to an organization and application. The scheduler claims one persisted monitor run at a time, revalidates the configuring membership and current inputs, reads exact commits and current advisory/status metadata, then atomically materializes a canonical customer audit/request/outbox. Leases and heartbeats fence writes; configuration changes cannot silently invalidate admitted active work. The existing audit lane executes the scanner, not the scheduler's HTTP lifetime. Unchanged commits still receive advisory queries and scheduled assessments.

Signed runtime events are durably authenticated before aggregation. Bounded versioned rules distinguish error/latency/resource pressure, supported suspicious behavior and provider context. Within a fixed ten-minute runtime-metric window, the first metrics snapshot is immutable; later batches rerun detectors against the expanded evidence window. Authentication-only detection, quota handling, and rollback behavior remain independent. This does not continuously refresh same-window metrics or establish a recovery measurement. Authentication detection, investigations, assessments and report-to-alert projections have separate delivery slots. Quota exhaustion degrades optional projection without blocking accepted baseline authentication detection. Permanent stale/archived report projections record terminal reasons and durable coverage gaps.

The opt-in `@gotchu/sdk` adds a Node HTTP middleware/context wrapper plus explicit sink wrappers for SQL, filesystem paths, shell commands, and outbound fetch/HTTP requests. It sends bounded, value-free detection evidence through the existing signed event endpoint and fetches an app-bound, signed policy through the same integration credential. Postgres stores the per-application mode/detector selection and a safe event projection under tenant-scoped access; runtime detections feed the existing coordinator alert path as indications, never proof of compromise. Block mode is an explicit Owner/Operator setting; absent/expired policy falls back to monitor. These are narrow pattern checks at wrapped sinks, not global hooks or comprehensive parsing. The in-memory event queue is bounded and may drop on prolonged outage or process exit. Custom HTTP callbacks remain responsible for redirects, and DNS rebinding between inspection and connection is not eliminated. Accuracy, host latency, capacity, and hosted operation have not been measured.

The dashboard displays alerts, evidence, freshness, coverage and advisory plans. Exact correction preparation loads the canonical report/request/source within tenant scope, selects a deterministic versioned recipe from the real finding and literal project context, then atomically stores a separate candidate source and queues an internal rescan. Replays bind the patch hash. No original repository, production deployment, secret issuer or provider is modified. Behavioral tests are not run.

Capacity and migration plans bind revisions/hashes. Customer checklist entries remain self-reported; readiness cannot enable production execution. Public provider status never proves application impact. See [operational setup and actual button effects](operations.md) for coverage and retention limits.
