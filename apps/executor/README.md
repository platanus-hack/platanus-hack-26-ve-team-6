# Independent executor integration contract

`@gotchu/executor` exports `createExecutor`, the v2 action ledger/provider, runtime schemas, and the explicit `customerCodeExecutionEnabled = false` gate. Approval creates a durable Postgres job and outbox record; the coordinator dispatches that job to the separate `gotchu-executions-v1` BullMQ queue. The executor process claims the Postgres lease and approval. It never runs inside an HTTP request handler, accepts user identity headers, or treats model output as authorization.

## Input and exact claim

The job input is strict:

```json
{
  "organizationId": "<uuid>",
  "applicationId": "<uuid>",
  "approvalId": "<uuid>",
  "expectedActionHash": "<64 lowercase hex characters>",
  "expectedResourceVersion": "<approved base commit SHA>"
}
```

No role, MFA timestamp, expiry, proposal body, provider target, or user ID is accepted from the job. `ExecutionLedgerPort.claim({ organizationId, approvalId })` maps to `backend.executions.claim`. That trusted backend operation rechecks the exact stored approval/hash, Owner role, fresh WebAuthn step-up proof and expiry, recovery epoch, active policy version, signed validation attestations, repository facts, and provider head through the independent `ActionVerifier` before atomically consuming approval and returning the durable claim.

The executor parses the returned claim and proposal fields again, then requires its organization, application, approval, exact action hash, and `proposal.baseCommit` to match the durable job. A stale resource version or hash mismatch stops before provider I/O. `assertWritable({ organizationId, executionId, claimToken })` maps to `backend.executions.assertWritable` and runs immediately before each provider write, including an allowed retry.

## Concrete backend ledger adapter

```ts
import { createDatabase } from '@gotchu/database';
import { createBackend } from '@gotchu/backend';
import { createBackendExecutionLedger, createExecutor } from '@gotchu/executor';

const database = createDatabase({ connectionString: executorRuntimeUrl, role: 'gotchu_executor' });
const backend = createBackend({ database });
const ledger = createBackendExecutionLedger(backend.executions);
const executor = createExecutor({ ledger }); // The generic v1 executor stays disabled without its provider adapter.
// The process owns database.close() during shutdown.
```

This server-only adapter requires the backend instance with its isolated executor login. Every execution method explicitly checks the trusted `database.role`; `createDatabase` verifies that the runtime login belongs to only that service role. FORCE RLS remains in force. Migrations 023 and 032 add the executor ledger, repository lock, policy registry, attempt history, and service heartbeat. Never send this adapter, execution records, or claim tokens through a public route.

The generic v1 executor port intentionally returns `unknown` across its boundary. The source PR executor separately validates the stored v2 action and recomputes its epoch-bound action hash before provider I/O. Jobs use lowercase UUIDs: the ledger rejects non-normalized organization/approval spellings before claiming because the executor compares strings. Backend ledger methods normalize valid UUID spellings for database identity checks without changing hashed proposal bodies.

Stale head, policy, artifacts, failed eligibility, and invalidation fail closed before provider writes. Expired/rejected authority also stops the job. Duplicate claims map to the existing-record reconciliation path.

- `findByApproval({ organizationId, approvalId })` returns the exact tenant/approval's existing execution, or `undefined`. It includes identity, claim token, hash, recovery epoch, validated proposal, state, and optional provider reference. Invalidated/expired proposals remain readable for reconciliation. A second approval of the same action never aliases the first approval's execution: it cannot publish and requires operator investigation if its own lookup is empty.
- `resolveUncertain({ organizationId, executionId, claimToken, outcome, providerReference? })` locks and updates only a matching `uncertain` execution to `succeeded | failed`. Success requires a nonblank provider reference from independent verification. It is a trusted recording operation: the executor must first reconcile and independently verify the provider; the database does not itself contact the provider. An identical terminal observation is a no-op, while a conflicting outcome/reference is rejected. The update and reconciliation audit commit together.

`claim` consumes approval once; `finish` records `succeeded | failed | uncertain` without reclaim. Duplicate deliveries reconcile and never publish again. Consumed approvals enter reconciliation even while recovery is frozen. Recording observations never advances the recovery epoch, unfreezes writes, returns a record to `claimed`, or reissues approval. Unknown provider observations remain uncertain.

## Provider adapter

`@gotchu/git-adapters` contains local Git and GitHub App adapters. Before publishing, the GitHub adapter reads `.github/workflows/*` from the pinned base and parses each workflow with the pinned `js-yaml` dependency. It denies malformed YAML, `pull_request_target`, unfiltered `push`, `push` filters matching `gotchu/**`, and non-`GITHUB_TOKEN` secrets in `pull_request` workflows. Workflow exceptions are Owner-managed, repository-scoped, versioned, audited records and are checked by both the independent verifier and writer.

The independent process loads the GitHub adapter only when the writer App file, installation ID, and operator repository catalog are all configured. It publishes the exact stored artifact to a deterministic branch, opens a draft PR, then rereads the PR, base head, and candidate tree from GitHub. A changed base invalidates the action and requires fresh validation and approval.

## Writer App credentials for the sandbox check

Keep the Writer App JSON outside the repository with mode `0600`. The live executor test reads its path from `GOTCHU_TEST_GITHUB_WRITER_APP_FILE`; it validates `id` and `privateKeyPem` without printing either value. The authorized sandbox installation and repository are fixed in that test. Run it with:

```sh
GOTCHU_TEST_GITHUB=1 \
GOTCHU_TEST_GITHUB_WRITER_APP_FILE=/absolute/path/to/gotchu-dev-writer-0bkevin.json \
pnpm --filter @gotchu/executor test:postgres
```

The executor uses `loadGitHubWriterAppCredentials`, which rejects symlinked or broadly readable files and requires an RSA key of at least 2048 bits. Configure `GOTCHU_GITHUB_WRITER_APP_FILE` and `GOTCHU_GITHUB_WRITER_INSTALLATION_ID` only for the executor service. Reader tokens, webhook secrets, and web authentication credentials are not passed to it.

The source PR provider implements:

- `publish({ executionId, actionHash, proposal })`: make only the exact supported PR write, using `executionId` as provider idempotency identity;
- `reconcile({ executionId, actionHash, proposal })`: return strict `found`, `definitely_not_applied`, or `unknown` state after an ambiguous timeout;
- `verify({ executionId, providerReference, actionHash, proposal })`: independently inspect the provider and exact candidate artifact, returning the matching reference, action hash, base commit, and candidate commit.

On a publish timeout the executor reconciles before retrying. It permits one retry with the same execution ID only when reconciliation proves that the first request was not applied and `assertWritable` succeeds again. An unknown result is durably marked uncertain; duplicate deliveries only reconcile and never publish. A provider response alone never yields `verified`; independent post-write verification must match the exact action hash, base SHA, candidate SHA, and provider reference.

Customer-code execution has no implementation and stays disabled until a disposable VM-class boundary is independently demonstrated. Merge, deploy, rollback, and production deployment remain separate release gates. Local development writes remain opt-in and limited to repositories explicitly present in the operator catalog.

## Validation limits

```sh
pnpm --filter @gotchu/contracts --filter @gotchu/database --filter @gotchu/backend --sort build
pnpm --filter @gotchu/executor build
pnpm --filter @gotchu/executor typecheck
pnpm --filter @gotchu/executor test
pnpm --filter @gotchu/executor test:postgres
```

Typecheck covers both actual source and tests under the root strict TypeScript settings. There is no package lint script. `test` runs unit fixtures and explicitly skips the live suite unless `GOTCHU_TEST_DATABASE_URL` points to an operator connection for a disposable `gotchu_test_*` database.

`test:postgres` starts disposable PostgreSQL 17.11 and Redis 7.4.11 containers on random loopback ports with random credentials and temporary storage, then removes only those named containers. It tests durable outbox/job approval, real Postgres leases and attempt history, Redis duplicates, and injected result loss after branch creation, PR creation, and verification. Other tests cover missing approval, revoked credentials, stale base, closed PR, and unknown remote state. The opt-in GitHub case creates one draft PR from a real stored artifact in the authorized private sandbox, verifies its tree digest, redelivers the job, then closes the PR and deletes its branch. Its signed validation and WebAuthn proof data are test fixtures; this is not live WebAuthn or a production rollout.

The Postgres/Redis crash tests use an injected provider and fixture WebAuthn/validation attestations. Only the opt-in GitHub case demonstrates a live provider write and exact tree verification. These checks do not prove live WebAuthn enrollment, VM isolation, production operations, merge, or deploy.
