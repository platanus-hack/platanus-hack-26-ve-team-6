# Gotchu customer application architecture

Gotchu's current product combines authenticated source/public HTTPS assessments, scoped periodic monitoring, signed runtime alerts and exact private correction preparation. Customers manage their own workspaces and applications, submit source snapshots, verify authorized HTTPS origins, and review persisted evidence-backed reports. The fictional vulnerable/corrected application is a regression fixture only; customer assessments accept customer-provided snapshots and verified targets.

The current supported runtime is local development. AWS is the eventual primary hosting target, with portable contracts and replaceable adapters. No cloud deployment or production-service claim is made here.

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
  coordinator -->|exact durable request| scanner --> engine
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

Auth.js owns session handling. The local development runtime enables a Credentials provider backed by local email/password accounts; passwords use a bounded scrypt profile and authentication attempts are rate-limited. Local registration requires both `NODE_ENV=development` and an explicit configuration flag. It is not enabled for production. No OAuth provider is required for local development. OIDC and GitHub OAuth can be configured as Auth.js providers, but no live production identity configuration is claimed.

New accounts start without a seeded workspace. A user can create and list workspaces; the creator receives the Owner role. The current customer API supports application create/list, rename, archive, and restore operations. Workspace invitation and member-management flows are not implemented. Archived applications cannot accept new sources or assessments until restored.

### Source snapshots

Customers submit normalized source snapshots directly to an application. The shared contract allows up to 4 MiB serialized per snapshot, 1,000 files, and 1 MiB per file; paths are restricted to supported relative JS/TS, JSON, YAML, and TOML files. The backend sorts files, calculates a canonical digest, deduplicates active identical snapshots, and stores source bytes in Postgres. No repository provider is required.

Owners and Operators can delete a snapshot. Deletion clears its stored body and hides the snapshot from active lists, but is rejected while a queued or running job depends on it. Assessments recheck that the stored snapshot still matches the durable digest. Customer code, package scripts, package installation, builds, and customer tests are never run.

### Authorized public HTTPS targets

Enrollment accepts a canonical public HTTPS origin only: a DNS hostname, no credentials, path, query, fragment, or custom port. The customer must affirm authorization and prove DNS control by publishing the issued random TXT challenge at `_gotchu.<hostname>`. The challenge expires after 30 minutes. Successful verification records the actor and time and authorizes the target for seven days. Customers can revoke authorization sooner; enrolling again creates a new version. Only one target is active for an application.

At scan time, the trusted HTTPS transport resolves the hostname again, rejects nonpublic or reserved answers, pins a validated public IP, verifies the certificate and original hostname, and honors the target's expiration deadline. It sends no customer credentials or cookies, does not follow redirects, and uses the exact consented profile. Root consent permits one GET to `/`; `public_surface` permits up to ten serial GETs to `/`, `/.well-known/security.txt`, `/security.txt`, `/robots.txt`, `/sitemap.xml`, and safe query-free same-origin links from readable HTML/robots/sitemap responses. It waits 250 ms between requests, reads at most 64 KiB total and 16 KiB per response. It does not execute JavaScript, query APIs, or discover subdomains. DNS, TLS, scope, cap or deadline failures remain unknown coverage. External assessment needs no source snapshot.

## Assessment modes and reports

The request contract binds source and target inputs to the selected mode:

| Mode | Source snapshot | Verified HTTPS target |
| --- | --- | --- |
| `internal` | Required | Not used |
| `external` | Not used | Required |
| `both` | Required | Required |

The internal and external branches collect evidence independently. Internal work uses bounded parsers against uploaded bytes. The current local scanner profile includes Semgrep CE 1.90.0, Gitleaks 8.28.0, Trivy 0.67.2, and an optional OSV-compatible package-lock lookup. It does not inspect installed packages or prove reachability. The OSV adapter sends package names and exact versions only. Semgrep 1.90.0 is enforced as development/test-only; the production runtime cannot execute this profile or receive green aggregate scanner readiness. A maintained scanner replacement and representative validation are required before production internal scanning.

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

The customer development launcher starts the web app on `127.0.0.1:3000`, the coordinator on `127.0.0.1:3003`, and the scanner service on `127.0.0.1:4400` by default. Ports can be overridden with `GOTCHU_DEV_WEB_PORT`, `GOTCHU_DEV_COORDINATOR_PORT`, and `GOTCHU_DEV_SCANNER_PORT`. It starts local Postgres and Redis data services, builds the required packages, and starts the services after their readiness checks pass. It does not seed the fictional target or create customer accounts/workspaces.

Postgres, Redis, and their volumes are local development data. `pnpm dev:stop` stops only the recorded app processes; data services remain available until separately stopped. The launcher stores process records, logs, and the scanner credential under `.local/dev`. See [local development instructions](development.md) for the complete lifecycle.

The scanner engine runs fixed, digest-pinned Docker parser images without network access, as a nonroot user, with bounded CPU, memory, process count, output, and wall time. These containers parse uploaded data; they are not a demonstrated VM-class isolation boundary. The scanner service must be placed behind an operator-controlled TLS terminator for production; the current local HTTP endpoint is loopback-only. External assessment itself uses verified HTTPS to the enrolled target.

## Portability and release gates

Core contracts and service ports are independent of AWS. AWS remains the planned primary hosting target, and no deployment or live AWS validation has been performed. Production requirements remain open, including:

- replace Semgrep 1.90.0 with a maintained production profile and validate accuracy, resource bounds, and readiness;
- demonstrate disposable VM-class isolation before enabling any customer-code execution;
- provide production TLS ingress for the web and scanner services;
- define and demonstrate backup, restore, and authorization reconciliation;
- implement production identity controls, including MFA and workspace invitations/member management;
- add independent provider-write adapters and exact approval semantics before any provider changes.

Customer monitoring and in-app alerts now use the durable event and assessment paths. Model investigation, external notifications, provider writes and recovery still have separate unavailable release gates. See [implementation status and gates](implementation-plan.md), the [architecture overview](architecture-overview.html), and the [historical product decisions and correction](definition-interview.md#current-user-correction-actual-customer-application-in-development).

## Continuous selected-input monitoring and correction preparation

An operator-scoped local Git/GitHub catalog binds every repository key to an organization and application. The scheduler claims one persisted monitor run at a time, revalidates the configuring membership and current inputs, reads exact commits and current advisory/status metadata, then atomically materializes a canonical customer audit/request/outbox. Leases and heartbeats fence writes; configuration changes cannot silently invalidate admitted active work. The existing audit lane executes the scanner, not the scheduler's HTTP lifetime. Unchanged commits still receive advisory queries and scheduled assessments.

Signed runtime events are durably authenticated before aggregation. Bounded versioned rules distinguish error/latency/resource pressure, supported suspicious behavior and provider context. Within a fixed ten-minute runtime-metric window, the first metrics snapshot is immutable; later batches rerun detectors against the expanded evidence window. Authentication-only detection, quota handling, and rollback behavior remain independent. This does not continuously refresh same-window metrics or establish a recovery measurement. Authentication detection, investigations, assessments and report-to-alert projections have separate delivery slots. Quota exhaustion degrades optional projection without blocking accepted baseline authentication detection. Permanent stale/archived report projections record terminal reasons and durable coverage gaps.

The dashboard displays alerts, evidence, freshness, coverage and advisory plans. Exact correction preparation loads the canonical report/request/source within tenant scope, selects a deterministic versioned recipe from the real finding and literal project context, then atomically stores a separate candidate source and queues an internal rescan. Replays bind the patch hash. No original repository, production deployment, secret issuer or provider is modified. Behavioral tests are not run.

Capacity and migration plans bind revisions/hashes. Customer checklist entries remain self-reported; readiness cannot enable production execution. Public provider status never proves application impact. See [operational setup and actual button effects](operations.md) for coverage and retention limits.
