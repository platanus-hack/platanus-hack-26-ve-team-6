# Independent executor integration contract

`@gotchu/executor` exports `createExecutor`, `createBackendExecutionLedger`, `ExecutionLedgerPort`, `ProviderAdapter`, runtime schemas, and the explicit `customerCodeExecutionEnabled = false` gate. The coordinator owns trusted queue claiming and may invoke the executor with a durable execution job. The executor does not run in an HTTP request handler, accept user identity headers, or receive model output as authorization.

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

No role, MFA timestamp, expiry, proposal body, provider target, or user ID is accepted from the job. `ExecutionLedgerPort.claim({ organizationId, approvalId })` maps to `backend.executions.claim`. That trusted backend operation must recheck the exact stored approval/hash, Owner role, fresh step-up proof and expiry, recovery epoch, current policy/tests, and current provider head through its independent `ProposalVerifier` before atomically consuming approval and returning the durable claim.

The executor parses the returned claim and proposal fields again, then requires its organization, application, approval, exact action hash, and `proposal.baseCommit` to match the durable job. A stale resource version or hash mismatch stops before provider I/O. `assertWritable({ organizationId, executionId, claimToken })` maps to `backend.executions.assertWritable` and runs immediately before each provider write, including an allowed retry.

## Concrete backend ledger adapter

```ts
import { createDatabase } from '@gotchu/database';
import { createBackend } from '@gotchu/backend';
import { createBackendExecutionLedger, createExecutor } from '@gotchu/executor';

const database = createDatabase({ connectionString: executorRuntimeUrl, role: 'gotchu_executor' });
const backend = createBackend({ database });
const ledger = createBackendExecutionLedger(backend.executions);
const executor = createExecutor({ ledger }); // Disabled: no production provider adapter.
// The process owns database.close() during shutdown.
```

This server-only adapter requires the backend instance with its isolated executor login. Every execution method explicitly checks the trusted `database.role`; `createDatabase` verifies that the runtime login belongs to only that service role. The existing FORCE RLS remains in force. Migration 023 adds the executor attempt ledger and grants access only to `gotchu_executor`. Never send this adapter, execution records, or claim tokens through a public route.

The port intentionally returns `unknown` across the adapter boundary. The adapter validates the complete stored action union (v1 or v2) and recomputes its version-specific epoch-bound hash. V1 remains executable through the existing gate. V2 claims are recognized structurally but return `ExecutionLedgerError('no_adapter')` before any provider adapter can run; the backend refuses them before consuming approval. Jobs use lowercase UUIDs: the adapter rejects non-normalized organization/approval spellings before claiming because the executor compares strings. Backend ledger methods normalize valid UUID spellings for database identity checks without changing hashed proposal bodies.

Stale head, policy, artifacts, failed eligibility, and invalidation map to `ExecutionLedgerError('stale_proposal')`; expired/rejected authority maps to `approval_rejected`; unavailable verification or malformed stored data fails closed as `ledger_unavailable`. Both `approval_used` and `already_claimed` map to the existing-record path.

- `findByApproval({ organizationId, approvalId })` returns the exact tenant/approval's existing execution, or `undefined`. It includes identity, claim token, hash, recovery epoch, validated proposal, state, and optional provider reference. Invalidated/expired proposals remain readable for reconciliation. A second approval of the same action never aliases the first approval's execution: it cannot publish and requires operator investigation if its own lookup is empty.
- `resolveUncertain({ organizationId, executionId, claimToken, outcome, providerReference? })` locks and updates only a matching `uncertain` execution to `succeeded | failed`. Success requires a nonblank provider reference from independent verification. It is a trusted recording operation: the executor must first reconcile and independently verify the provider; the database does not itself contact the provider. An identical terminal observation is a no-op, while a conflicting outcome/reference is rejected. The update and reconciliation audit commit together.

`claim` consumes approval once; `finish` records `succeeded | failed | uncertain` without reclaim. Duplicate deliveries reconcile and never publish again. Consumed approvals enter reconciliation even while recovery is frozen. Recording observations never advances the recovery epoch, unfreezes writes, returns a record to `claimed`, or reissues approval. Unknown provider observations remain uncertain.

## Provider adapter

`@gotchu/git-adapters` now contains local Git and GitHub App adapters, but the executor process has not been wired to them. If `ProviderAdapter` is omitted, `execute()` returns `disabled` before consuming approval or calling the ledger. The fake adapters in the ledger tests remain test fixtures; the separate opt-in GitHub adapter suite is labeled as a real provider check.

## Writer App credentials for the sandbox check

Keep the Writer App JSON outside the repository with mode `0600`. The live adapter test reads its path from `GOTCHU_TEST_GITHUB_WRITER_APP`; it validates `id` and `privateKeyPem` without printing either value. The authorized sandbox installation and repository are fixed in that test. Run it with:

```sh
GOTCHU_TEST_GITHUB=1 \
GOTCHU_TEST_GITHUB_WRITER_APP=/absolute/path/to/gotchu-dev-writer-0bkevin.json \
pnpm --filter @gotchu/git-adapters test
```

`loadGitHubWriterCredentials(path, target)` is the executor-only credential loader for a future process entry point. It rejects symlinked or broadly readable files. Configure the future service with `GOTCHU_GITHUB_WRITER_APP=/absolute/path/to/writer-app.json`; the path is read only by the executor process. The long-lived executor service is not implemented in this change, so setting this variable does not enable application writes.

An enabled adapter must implement:

- `publish({ executionId, actionHash, proposal })`: make only the exact supported PR write, using `executionId` as provider idempotency identity;
- `reconcile({ executionId, actionHash, proposal })`: return strict `found`, `definitely_not_applied`, or `unknown` state after an ambiguous timeout;
- `verify({ executionId, providerReference, actionHash, proposal })`: independently inspect the provider and exact candidate artifact, returning the matching reference, action hash, base commit, and candidate commit.

On a publish timeout the executor reconciles before retrying. It permits one retry with the same execution ID only when reconciliation proves that the first request was not applied and `assertWritable` succeeds again. An unknown result is durably marked uncertain; duplicate deliveries only reconcile and never publish. A provider response alone never yields `verified`; independent post-write verification must match the exact action hash, base SHA, candidate SHA, and provider reference.

Customer-code execution has no implementation and stays disabled until a disposable VM-class boundary is independently demonstrated. The GitHub adapter package does not yet enable writes from the product executor; wiring, D05 artifact persistence, diff-digest verification, safe workflow inspection in the web verifier, and the durable worker remain release gates.

## Validation limits

```sh
pnpm --filter @gotchu/contracts --filter @gotchu/database --filter @gotchu/backend --sort build
pnpm --filter @gotchu/executor build
pnpm --filter @gotchu/executor typecheck
pnpm --filter @gotchu/executor test
pnpm --filter @gotchu/executor test:postgres
```

Typecheck covers both actual source and tests under the root strict TypeScript settings. There is no package lint script. `test` runs unit fixtures and explicitly skips the live suite unless `GOTCHU_TEST_DATABASE_URL` points to an operator connection for a disposable `gotchu_test_*` database.

`test:postgres` uses the database package's isolated fixture/provisioning/migration harness. Like the backend runner, it starts a disposable `postgres:17-alpine` container on a random loopback port with random credentials and temporary storage, then removes it. It tests `createExecutor` through this concrete adapter and real Postgres: exact concurrent/repeated delivery, uncertain settlement, tenant/hash/application/version rejection, expiry and stale eligibility, forged tokens, a second approval for the same action, and frozen recovery. The backend suite additionally tests restricted roles, corrupt records, invalid states, terminal fencing, and concurrent/idempotent settlement.

These are real persistence and authorization checks with a clearly labeled in-memory provider and injected MFA/eligibility fixtures. They do not prove live GitHub behavior, actual MFA, model calls, scanner attestations, or VM isolation. Production provider/customer-code execution remains disabled; a separately validated live adapter and verifier remain release gates.
