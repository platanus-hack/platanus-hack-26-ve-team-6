# Gotchu architecture overview

Gotchu uses a dashboard and API to coordinate deterministic audits and detection, an optional bounded AI investigator, and an independently authorized PR executor. Teams receive evidence and supported corrections; they retain incident response, merge, and deployment responsibility. Nontechnical owners can review explanations and approve PR creation.

This is the proposed service layout for the accepted pilot direction. VM hosting, provider race handling, total cost, and recovery performance must be validated before release.

## Services and responsibilities

### Dashboard and API

The web application combines the dashboard with Auth.js sign-in and sessions. TanStack Start is the preferred candidate for the dashboard workflow if its Auth.js integration is validated; Next.js remains the alternative with a direct documented Auth.js setup. The user has selected Auth.js and is comparing the web frameworks. The public REST API covers applications, integrations, coverage, findings, incidents, proposals, approvals, and job status. Long operations return job IDs; authorized status projections stream updates.

For the pilot, host versioned public HTTP endpoints in the web server using TanStack Start server routes or Next.js Route Handlers, according to the selected framework. The original reference used a separate Fastify service; a separate public API deployment is optional at this stage. Route files stay thin: runtime validation, tenant authorization, and use cases live in independent backend modules. OpenAPI and job contracts remain stable if the HTTP host changes. Scanners, LangGraph runs, and execution never run as long-lived work inside a route handler.

The API validates input, authenticates integrations independently of user sessions, derives tenant identity, and enforces membership and application permissions. Auth.js supplies authentication; organization roles, approval policy, and fresh second-factor verification remain explicit application responsibilities. A normal signed-in session does not satisfy the approval step-up requirement.

### HTTP framework options

Fastify provides schema-based request validation and response serialization, request lifecycle hooks, and an available structured logger. A separate API service also allows UI and HTTP ingestion to be deployed and scaled independently. These are useful operational features, rather than prerequisites for the pilot's authorization model. Retaining that separation would also require a trusted way for the API to verify Auth.js identity and session state; caller-supplied identity headers are insufficient.

Next.js Route Handlers can receive HTTP requests, including webhooks, validate them through shared schemas, commit Postgres transactions, and enqueue durable work through the outbox. Consolidating UI and public HTTP endpoints removes one service to deploy, while coupling their deployment and resource consumption. Runtime validation, rate limits, logging, stable REST contracts, and the outbox must still be implemented explicitly.

TanStack Start provides typed routing, search-parameter handling, server routes, and server functions. Combined with TanStack Query, its navigation and cache model fits the dashboard's filtering, incident navigation, background refreshes, and invalidation after approvals. This is a product-fit judgment; Next.js can also use TanStack Query. Choosing Start replaces the web and HTTP adapter while preserving the independent backend modules and workers.

Auth.js's official integration list does not currently include TanStack Start. A supported community integration or a maintained adapter around Auth.js Core must be validated before committing to that combination. Verify sign-in callbacks, session behavior, CSRF protection, logout, and the separate fresh second-factor approval flow. Next.js has the direct documented integration and is the simpler alternative if minimizing auth integration work takes priority.

Framework references: [Auth.js installation](https://authjs.dev/getting-started/installation), [Auth.js integrations](https://authjs.dev/getting-started/integrations), [Auth.js roles](https://authjs.dev/guides/role-based-access-control), [Next.js HTTP endpoints](https://nextjs.org/docs/app/guides/backend-for-frontend), [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview), [TanStack Query integration](https://tanstack.com/start/latest/docs/framework/react/guide/tanstack-query), [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes), [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/), and [Fastify logging](https://fastify.dev/docs/latest/Reference/Logging/).

### Durable state and job coordination

Postgres holds customer state, evidence metadata, findings, incidents, job intent, checkpoints, policies, exact proposals, approvals, execution records, and audit logs. Tenant-aware foreign keys and row security apply through restricted runtime roles. Customer routes do not expose credentials or private checkpoints.

The API commits accepted events and an outbox entry in one transaction before acknowledgment. An outbox dispatcher places job IDs in BullMQ backed by persistent Redis. Consumers claim durable work and tolerate duplicate delivery. Postgres remains the authority for job intent and execution state.

A background service schedules onboarding, debounced-change, and periodic scans. It also normalizes evidence, aggregates events, evaluates versioned rules, maintains integration freshness, and dispatches notifications. These functions continue when model investigations are disabled, delayed, or over budget.

### Investigation worker and gateways

A persistent LangGraph JS worker investigates material findings or incidents after the required deterministic checks. Initial limits are four model calls, eight additional read-tool calls, and five minutes of active investigation, plus token and spending limits.

The worker accesses evidence, repository excerpts, inventory, cloud snapshots, and saved progress through a gateway authorized for the current run. It receives no general customer database connection or integration credentials. Scoped persistence access saves checkpoints without exposing other tenants, approvals, or credential tables.

The proposed gateway also brokers model calls, keeping provider keys outside the investigation process and enforcing budget reservations. External model processing requires organization opt-in. A worker compromise must not enable approval issuance, credential retrieval, or provider writes. Its permitted evidence exposure, capabilities, and revocation semantics require explicit implementation tests.

### Scanner host and disposable job VMs

A separate runner host accepts fixed scanner profiles and scoped input artifacts. It runs Semgrep CE, OSV-Scanner, Gitleaks, and Trivy configuration checks under resource and output limits. Scanner jobs have no control-plane database access, integration credentials, production credentials, privileged host mounts, or Docker socket.

Executing dependency installation scripts or customer tests requires a disposable VM-class boundary per job. A controlled preparation service requests an allowed dependency update, receives the candidate patch, and validates its permitted files and contents. Validation runs an independent targeted rescan and the configured relevant test suite against the proposed commit. Only scoped input and bounded result-upload grants enter the job. Network destinations and resource usage are constrained.

The two reference VPSs do not establish that this VM boundary is available. A compatible runner deployment or additional disposable compute must be selected and costed. Until isolation and relevant validation pass, the platform withholds the tested-PR path and can provide an explicitly unverified patch.

### Approvals and restricted executor

The server creates an immutable typed proposal binding the organization, application, adapter, target, exact parameters and patch, evidence, base commit, policy version, test results, and verification plan. It computes the action hash. Model output is a draft input to this process, not authorization.

An authorized Owner, including a nontechnical Owner, approves that exact hash using fresh second-factor authentication. The approval is short-lived and usable once. Merge and deployment remain separately authorized.

The executor runs as a separate restricted service with its own runtime identity, narrow database permissions, and custody of the write capability. It independently validates approval, role, policy, expiry, expected state, and artifact identity. It locks and claims execution durably, rechecks the target, and publishes the exact tested commit and PR. Any observed base-head change requires regeneration or rebasing, validation, and fresh approval. Repositories must also meet supported automation-safety conditions before PR writes are enabled.

After an uncertain provider timeout, the executor reconciles provider state before retrying. A separate verification step checks the resulting PR and commit against the authorized artifact. API success alone does not establish verification. The initial adapter supports security patch and minor npm dependency upgrades with reproducible lockfiles. Other findings remain reportable.

## Customer workflows

### Repository audit

1. The customer connects selected GitHub repositories. Repository-only onboarding can provide value before runtime telemetry or cloud access is configured.
2. The API records audit intent, and the outbox dispatches a scan job.
3. The runner receives a fixed profile and scoped snapshot, then uploads bounded results to private object storage.
4. The control plane validates and normalizes results into evidence and findings. Evidence records commit or snapshot identity, collection time, tool version, checksum, and retention deadline.
5. An eligible material finding can start a bounded investigation. The dashboard shows coverage and investigation state alongside the finding.

### Live monitoring

1. A Node application sends signed batches with stable event IDs. Optional Cloudflare telemetry and scoped AWS snapshots supply additional inputs when configured and supported.
2. The API authenticates, validates, deduplicates, and durably accepts events with outbox intent. Quota or capacity rejection is explicit; client buffering and retries are bounded.
3. Deterministic rules evaluate aggregates before invoking a model. Blocked attempts, suspicious activity, and confirmed compromise remain distinct.
4. Material incidents can start investigations and notify the named responder. Delivery, acknowledgment, investigation, and resolution have separate states.
5. Telemetry gaps, sampling, stale connectors, and failed notification routes remain visible. Existing customer WAF enforcement continues independently; the pilot does not perform automatic containment.

### Approved correction

1. Prepare an allowed dependency patch in isolation.
2. Independently rescan and run relevant validation at the candidate commit.
3. Store the exact proposal and server-computed hash.
4. Obtain fresh human approval for that hash.
5. Independently recheck and claim execution, publish once despite retries, and verify the resulting PR.
6. The customer's technical team reviews, merges, and deploys through its own controls.

## Proposed deployment

VPS A hosts the selected web framework with Auth.js, the public HTTP API, trusted job coordination and detection services, gateways, LangGraph process, restricted executor, Postgres, and Redis. The recommended pilot layout hosts the public API in the web application through Start server routes or Next.js Route Handlers; the original separate Fastify service remains an alternative. Workers, gateways, and the executor retain separate service identities and permissions even when processes share a host. This layout does not claim isolation against a complete VPS A host compromise.

VPS B hosts the trusted runner supervisor and isolated static scanner jobs. Customer-code execution uses the separate disposable VM boundary described above, wherever a compatible deployment can be demonstrated. Trusted runner components orchestrate jobs; untrusted jobs receive neither the runner's control interface nor host privileges.

Private object storage outside both VPSs holds evidence artifacts and encrypted backups. Continuous Postgres recovery data and base backups are the proposed recovery mechanism, subject to a successful restoration drill. Docker Compose deploys the fixed services; Pulumi TypeScript provisions infrastructure. GitHub CI builds and releases the platform.

GitHub, the customer Node deployment, scoped AWS metadata, optional Cloudflare telemetry, one model provider, and transactional email are external dependencies. Provider reads pass through the integration gateway. Authorized GitHub writes pass through the executor.

## Pilot limits and release gates

The workload target is five organizations and ten applications, one active scanner, two active investigations, ten security events per second sustained, and a bounded 100-event-per-second burst. Detection targets thirty seconds after acceptance; upstream delivery delay is measured separately. Events initially retain for seven days and incident evidence for thirty days.

The total operating-spend ceiling is provisionally USD 250 per month, excluding engineering labor and customer-paid provider charges. It is a budget, not a verified infrastructure estimate. Model limits apply even to critical incidents; deterministic detections and alerts continue within their separate resource limits.

Disaster-recovery objectives are at most fifteen minutes of lost customer state and accepted events, and core restoration within four hours. These require measured restoration evidence. A restore invalidates pre-recovery approvals and freezes writes until external executions have been reconciled.

Before implementation commitments, resolve the VM host and cost, supported repository and workflow configurations, adequacy of customer validation, notification channels and escalation, provider concurrency guarantees, exact role permissions, and measurable customer-value criteria. Reconcile the unavailable detailed implementation reference with the accepted decision record before finalizing contracts.
