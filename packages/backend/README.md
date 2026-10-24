# Backend integration contract

Framework-independent services for TanStack Start/Auth.js, trusted coordinators and gateways, and the independent executor. Libraries build ESM into `dist` using the root TypeScript settings. Build contracts and database before backend.

```ts
import { createDatabase } from '@gotchu/database';
import { createBackend } from '@gotchu/backend';

const database = createDatabase({ connectionString: runtimeUrl, role: 'gotchu_api' });
const backend = createBackend({ database }); // Approvals disabled until trusted verifiers are injected.
await database.checkHealth(); // Verifies restricted runtime login; needs no customer selector.
```

Use separate runtime logins and backend instances for `gotchu_api`, `gotchu_ingest`, `gotchu_coordinator`, and `gotchu_executor`. Database permissions constrain each instance even though `createBackend` returns the same service interface. Never use an operator/migration connection at runtime. The investigation process gets neither this backend object nor a database connection: expose only a run-scoped authenticated gateway to it.

## HTTP adapter contract

### Controlled assessment integration

`backend.assessments` uses the shared `AssessmentRunInput` and `AssessmentReport` contracts. These are observation-only controlled checks; reports never grant verified remediation or action permission.

- `queue(identity, { organizationId, applicationId, mode, revision, idempotencyKey }): Promise<{ jobId: string }>` authorizes Owner/Operator membership, selects the operator-enabled target, and commits request, audit job, outbox and audit record together. Reusing a key with another mode, revision or configured target fails with `idempotency_conflict`.
- `getTarget(identity, { organizationId, applicationId }): Promise<{ targetKey: string } | null>` authorizes membership and returns the enabled opaque target key, never a URL or filesystem path.
- `list(identity, { organizationId, applicationId, limit? }): Promise<AssessmentReportSummary[]>` returns at most 50 report summaries (default 20).
- `get(identity, { organizationId, applicationId, reportId }): Promise<AssessmentReport>` authorizes membership and loads one validated report. Use `web.getJob` to poll jobs; successful assessment jobs expose `reportId`.
- Coordinator only: `getRequest({ organizationId, applicationId, jobId, leaseToken }): Promise<AssessmentRunInput>` checks the current audit-job lease, persisted request, job payload, and enabled target before returning trusted runner input.
- Coordinator only: `recordResult({ input: AssessmentRunInput, leaseToken: string, report: unknown }): Promise<{ reportId: string }>` validates the report, checks input/report/request scope and the enabled target, and stores the report plus job completion in one transaction under the current lease. Both serialized report JSON and stored JSONB text are bounded at 1 MiB. Expired/replaced leases roll back all effects.

Targets are operator-managed rows in `gotchu.assessment_targets`; API/coordinator roles can only read them. Each app has at most one enabled target. To change it, disable the previous row and enable a new key in one operator transaction. Existing requests retain their original key and cannot be redirected. No request accepts a target URL/path/key. The adapter resolves `controlled-demo-store` to its operator-configured fixtures and HTTP origin.

The operator-only `node scripts/assessment-demo-seed.mjs` uses `GOTCHU_MIGRATION_DATABASE_URL` after package builds. It creates only `DEMO_ASSESSMENT_SCOPE` (exported by backend) and the fixed `DEMO_ASSESSMENT_TARGET_KEY`. It is repeatable and refuses conflicting existing scope/configuration instead of overwriting it. The migration/operator login must see all rows; runtime credentials are insufficient. The reserved `demo:controlled-assessment` principal is deliberately public, not an authenticated customer identity. Generic backend operations deny it; only assessment operations and job polling for the fixed app accept it after membership checks. The public HTTP adapter must be opt-in, enforce origin/body/usage bounds, inject this fixed scope, and call these same membership-authorized assessment methods. Never accept that principal from a customer session or expose operator credentials at web startup.

The fixed scope is organization `d3e00000-0000-4000-8000-000000000001`, application `d3e00000-0000-4000-8000-000000000002`, user `demo:controlled-assessment`, with target `controlled-demo-store`. Its queue transaction permits at most three unfinished audit jobs and 100 total audit jobs, serialized under the target lock across API instances. Exact idempotent retries return before quota checks. New work fails with HTTP 429 `assessment_capacity_exceeded` or `demo_assessment_limit`; the lifetime bound requires deliberate operator cleanup in a disposable demonstration environment. These are admission bounds, not measured throughput guarantees.

Legacy `web.queueAudit` jobs contain no assessment request and remain visibly unavailable to a configured runner. New assessment HTTP adapters must use `assessments.queue` and the explicit mode/revision contract.

`backend.events.ingest({ integrationId, timestamp, signature, rawBody })` takes the exact received Buffer. `MAX_EVENT_BODY_BYTES` is 256 KiB; enforce it while streaming, before buffering. At most 100 events fit the shared `eventBatchSchema`. The integration supplies the organization and application; `signed_events` only accepts `source: 'application'`.

HMAC-SHA256 input is the UTF-8 prefix `gotchu-events-v1\n${integrationId}\n${timestamp}\n`, followed by the exact raw bytes. Timestamp is decimal Unix seconds within 300 seconds of server time. Signature is 64 lowercase hex characters. `signEventBody` and `verifyEventSignature` are exported. `CredentialStore.getSigningSecret(reference): Promise<Uint8Array>` must resolve at least 32 secret bytes from an external secret store or encrypted adapter; the database only stores an opaque reference in the intake-only credential table.

The response is `{ accepted, duplicates, jobId: string | null }`. Stable event IDs deduplicate per integration; changed event content rejects the entire batch. UUID spelling is normalized; object key order is immaterial. A response is returned only after the event, durable job, outbox, and audit transaction commits. A repeated batch returns zero accepted and `jobId: null`. These body/batch bounds are not measured sustained-rate or per-tenant quota guarantees.

Customer web methods take `identity: { userId: string }` exclusively from a trusted server-side Auth.js session (for example `github:<providerAccountId>`). The fixed public assessment demo above is a separate, explicitly restricted entry point. Organization IDs select a tenant; every method checks membership inside the transaction. Cookie-authenticated routes must enforce same-Origin/CSRF protections in the web adapter. Domain services do not consume identity headers.

- `web.authorize(identity, organizationId, roles?)` returns `owner | operator | viewer`.
- `web.listApplications(identity, { organizationId })` returns `{ id, name }[]`.
- `web.queueAudit(identity, { organizationId, applicationId, idempotencyKey })` returns `{ jobId }`; Owner or Operator only.
- `web.getJob(identity, { organizationId, jobId })` returns `{ id, applicationId, kind, state, attempts, createdAt, completedAt, outcome, reasonCode, reportId }`. Payload and private checkpoints are excluded; `reportId` is null before successful assessment completion.
- `web.listIncidents`, `web.getCoverage`, and `web.listProposals` take `(identity, { organizationId, applicationId })`. Lists are bounded at 100. Coverage synthesizes explicit unconfigured/unsupported states; customer-code execution is unsupported until a separately verified VM boundary exists.

Expected failures are `BackendError` with `code` and HTTP `status`. Invalid runtime contracts fail as `invalid_input`. Do not expose unexpected database/credential/provider exception details in HTTP responses.

## Coordinator contract

The scheduler supplies trusted organization IDs; there is no global customer enumeration endpoint.

- `outbox.claim({ organizationId, limit?, leaseMs? })` returns `{ id, envelope: JobEnvelope, leaseToken, leaseUntil, attempts }[]`. Publish `envelope` with its stable job ID, then call `outbox.delivered({ organizationId, id, leaseToken })`. A crash after publish may deliver the same job again.
- `jobs.claim({ organizationId, jobId, leaseMs? })` returns `{ envelope, payload, leaseToken, leaseUntil, attempts } | null`. Null means already completed or currently leased. `jobs.heartbeat({ organizationId, jobId, leaseToken, leaseMs? })` and `jobs.complete({ organizationId, jobId, leaseToken, result? })` fence expired/stale owners. Leases default to 30 seconds, bounded between 1 second and 5 minutes, using the database clock.
- Exported `enqueue(tx, { organizationId, applicationId, id, kind, idempotencyKey, payload? })` commits job plus outbox inside the caller's business transaction. `completeJob(tx, { organizationId, jobId, leaseToken, result? })` allows deterministic effects and completion to commit together. Persist effects under unique stable identities; a lease does not make a remote side effect exactly-once.
- `runs.start({ organizationId, applicationId, jobId, leaseToken })` requires a claimed investigation job and returns `{ runId, deadline }`. Retries return the same run and deadline. `runs.load({ organizationId, runId })` returns its private checkpoint and counters.
- `runs.checkpoint({ organizationId, runId, expectedVersion, checkpoint })` returns `{ version }`; optimistic concurrency fences stale updates and limits checkpoints to 32 KiB. The gateway derives scope from its authenticated run capability, never from arbitrary agent-supplied IDs.
- `runs.consumeTool({ organizationId, runId })` reserves one of eight tool calls. `runs.reserveModel({ organizationId, runId, reservationId, maxCostMicros })` requires external-processing opt-in, a live five-minute deadline, at most four calls, and available organization budget. Call before provider I/O. A reused reservation ID fails as `reservation_exists`, requiring reconciliation, never a repeated model call.
- `runs.settleModel({ organizationId, reservationId, actualCostMicros })` settles once, idempotently for the same amount. Unknown outcomes retain their full reservation across restarts. The gateway must reserve an actual worst-case charge and bound provider tokens/prices; an overrun fails and requires operator reconciliation. `runs.finish({ organizationId, runId, outcome })` accepts `succeeded | unavailable | failed` and refuses unsettled reservations. Declining opt-in or exhausting budget does not block deterministic event processing.

## Proposal and executor contract

`proposalSchema`, `proposalEligibilitySchema`, `verifiedStepUpSchema`, and their derived TypeScript types are exported. `Clock.now(): Date` is injectable for authentication/freshness tests; production must use a trustworthy server clock.

`proposals.create({ organizationId, proposal })` is a **trusted preparation-service method**, not a public model-output endpoint. It returns `{ proposalId, actionHash, recoveryEpoch }`. Typed proposals bind organization/application, allowed adapter, repository/branch, full base/candidate commits, increasing patch/minor dependency versions, artifact identity/digests, evidence provenance, policy version, test attestations, and an exact verification plan. `hashProposal(proposal, recoveryEpoch)` hashes canonical JSON with a versioned domain prefix. Identical proposals within an epoch return the same identity. Only invalidation metadata is mutable.

Inject `ProposalVerifier.verify(proposal, { phase: 'proposal' | 'approval' | 'execution' })` as an independent trusted service that inspects current policy, provider head, immutable artifacts, and scanner/test attestations. It returns fresh facts binding the exact commits, digests, attestation IDs, and policy plus required rescan, relevant suite, VM isolation, and repository automation-safety checks. The default is unavailable. Returning flags from an HTTP request or model output is not verification. Observing a changed head, changed artifacts/policy, or failed eligibility persists proposal invalidation before returning the rejection; a later head reversion cannot revive approval.

`proposals.approve(identity, { organizationId, proposalId, actionHash, stepUpProof })` returns `{ approvalId, expiresAt }`. Owner membership is row-locked against revocation. Inject `StepUpVerifier.verify({ proof, userId, organizationId, actionHash })`, validating an actual server-issued WebAuthn/TOTP second-factor ceremony. The returned `proofId`, identity/action binding, authentication/expiry times and method come from trusted verifier state. Proof IDs are single-use. Caller-supplied timestamps and extra keys are rejected. Proof freshness and approval lifetime are at most five minutes. Without this verifier approval is disabled.

The separate executor uses `executions.claim({ organizationId, approvalId })`, returning `{ executionId, claimToken, actionHash, proposal, recoveryEpoch }`. It rechecks current owner membership, proof-derived expiry, action hash, recovery state, independent policy/tests and provider head, then atomically consumes approval and claims a unique execution. Call `executions.assertWritable({ organizationId, executionId, claimToken })` immediately before provider I/O; it checks membership, expiry, recovery, and current proposal eligibility again. Use `executionId` for provider reconciliation/idempotency. `executions.finish({ organizationId, executionId, claimToken, outcome, providerReference? })` records `succeeded | failed | uncertain`; succeeded requires a provider reference. This records the adapter's outcome, not a claim of independent post-write verification.

There is no automatic execution reclaim: a crash or uncertain provider result requires reconciliation. This ledger cannot make Postgres and a remote provider atomic. A real GitHub adapter must demonstrate race handling, exact artifact publication, reconciliation, and post-write verification before enabling writes. No provider write API is implemented in this package.

## Database, recovery and checks

`createDatabase` exposes `tenant(organizationId, fn)`, intake-only `integration(integrationId, fn)`, `checkHealth()`, and `close()`. Context is parameterized and transaction-local. Runtime logins are rejected if privileged, if they own a Gotchu object, or if they belong to multiple service roles. Customer tables FORCE RLS and enforce tenant-aware foreign keys. See `packages/database/README.md` for operator-only provisioning/migration/recovery helpers.

Writes start frozen. Following restore, stop executors and call `setRecoveryState({ connectionString: operatorUrl, mode: 'freeze' })` before restarting them. This advances the epoch and invalidates old approvals. Unfreeze only after external execution identities have been reconciled using `mode: 'reconciled', reconciliationReference`. This is an explicit operations gate, not a proven restoration procedure.

Commands after installing workspace dependencies:

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/database build
pnpm --filter @gotchu/backend build
pnpm --filter @gotchu/database typecheck
pnpm --filter @gotchu/backend typecheck
pnpm --filter @gotchu/backend test
pnpm --filter @gotchu/database test:postgres
```

The last command creates its own `postgres:17-alpine` container, random loopback port and random credentials, uses temporary storage without existing volumes, runs both packages' live tests, and removes that container. Alternatively set `GOTCHU_TEST_DATABASE_URL` to an operator connection for a disposable database named `gotchu_test_*`. Without it, live suites are explicitly skipped. MFA/eligibility unit fixtures do not prove real MFA, scanners, VM isolation, or provider integration; live database tests prove the ledger and persistence behavior against Postgres.

Remaining release gates include production credential-store/MFA/verifier adapters, trusted run-capability routing, provider concurrency/reconciliation and verification, measured quotas/retention, migrations/provisioning in deployment, external backups/restoration drills, and live VM isolation. Customer code and production provider writes remain disabled.
