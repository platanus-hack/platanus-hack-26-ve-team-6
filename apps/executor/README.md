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

This server-only adapter requires the backend instance with its isolated executor login. Every execution method explicitly checks the trusted `database.role`; `createDatabase` verifies that the runtime login belongs to only that service role. FORCE RLS remains in force. Migrations 023, 032, and 038 add the executor ledger, repository lock, policy registry, attempt history, service heartbeat, and Owner-verified Writer App grant. Never send this adapter, execution records, or claim tokens through a public route.

The generic v1 executor port intentionally returns `unknown` across its boundary. The v2 executor validates stored source-patch and npm dependency actions and recomputes their epoch-bound action hash before provider I/O. Jobs use lowercase UUIDs: the ledger rejects non-normalized organization/approval spellings before claiming because the executor compares strings. Backend ledger methods normalize valid UUID spellings for database identity checks without changing hashed proposal bodies.

Stale head, policy, artifacts, failed eligibility, and invalidation fail closed before provider writes. Expired/rejected authority also stops the job. Duplicate claims map to the existing-record reconciliation path.

- `findByApproval({ organizationId, approvalId })` returns the exact tenant/approval's existing execution, or `undefined`. It includes identity, claim token, hash, recovery epoch, validated proposal, state, and optional provider reference. Invalidated/expired proposals remain readable for reconciliation. A second approval of the same action never aliases the first approval's execution: it cannot publish and requires operator investigation if its own lookup is empty.
- `resolveUncertain({ organizationId, executionId, claimToken, outcome, providerReference? })` locks and updates only a matching `uncertain` execution to `succeeded | failed`. Success requires a nonblank provider reference from independent verification. It is a trusted recording operation: the executor must first reconcile and independently verify the provider; the database does not itself contact the provider. An identical terminal observation is a no-op, while a conflicting outcome/reference is rejected. The update and reconciliation audit commit together.

`claim` consumes approval once; `finish` records `succeeded | failed | uncertain` without reclaim. Duplicate deliveries reconcile and never publish again. Consumed approvals enter reconciliation even while recovery is frozen. Recording observations never advances the recovery epoch, unfreezes writes, returns a record to `claimed`, or reissues approval. Unknown provider observations remain uncertain.

## Provider adapter

`@gotchu/git-adapters` contains local Git and GitHub App adapters. Before publishing, the GitHub adapter reads `.github/workflows/*` from the pinned base and parses each workflow with the pinned `js-yaml` dependency. It denies malformed YAML, `pull_request_target`, unfiltered `push`, `push` filters matching `gotchu/**`, and non-`GITHUB_TOKEN` secrets in `pull_request` workflows. Workflow exceptions are Owner-managed, repository-scoped, versioned, audited records and are checked by both the independent verifier and writer.

The independent process loads the GitHub adapter only when the Writer App file, installation ID, and operator repository catalog are all configured. It publishes the exact stored artifact to a deterministic branch, opens a draft PR, then rereads the PR, base head, commit parent, and candidate tree from GitHub. Source-patch actions bind their approved tree SHA. Dependency actions are limited to the stored `package.json` and `package-lock.json`; they bind the npm candidate tree plus a deterministic commit SHA whose author, committer, timestamp, and message are fixed. The PR body lists package version changes, linked OSV advisories, signed validation evidence, and the action review URL. A changed base invalidates the action and requires fresh candidate validation and approval.

The executor calls `assertWritable` before every provider write. Ref creation is conditional; a timeout triggers remote reconciliation before any retry. An existing branch or PR is accepted only when its commit parent, base, head and tree match the stored action. Unknown state stays uncertain, and a new base requires a new approval.

### Owner grant for repository writes

Repository links start with `write_access='not_granted'`. A workspace Owner can grant or revoke access in the repository panel after a fresh WebAuthn assertion bound to the grant/revocation hash. Granting calls the private executor verification endpoint; the Writer App must successfully read the linked repository's current base through the configured installation. Only the verified installation ID, timestamp and base commit are stored. The web process never loads the Writer App key. Revocation invalidates pending source and dependency approvals and consumes their outstanding approvals.

Compose shares `GOTCHU_EXECUTOR_INTERNAL_TOKEN` only between web and executor over the internal `data` network. The executor verification endpoint has no host-published port. The token authenticates repository coverage checks and is not a GitHub credential.

## Writer App credentials for the sandbox check

Keep the Writer App JSON outside the repository with mode `0600`. The live executor test reads its path from `GOTCHU_TEST_GITHUB_WRITER_APP_FILE`; it validates `id` and `privateKeyPem` without printing either value. The authorized sandbox installation and repository are fixed in that test. Run it with:

```sh
GOTCHU_TEST_GITHUB=1 \
GOTCHU_TEST_VM=1 \
GOTCHU_TEST_GITHUB_WRITER_APP_FILE=/absolute/path/to/gotchu-dev-writer-0bkevin.json \
sg kvm -c 'PATH=/home/ubuntu/.local/gotchu-bin:$PATH pnpm --filter @gotchu/executor test:postgres'
```

The executor uses `loadGitHubWriterAppCredentials`, which rejects symlinked or broadly readable files and requires an RSA key of at least 2048 bits. Configure `GOTCHU_GITHUB_WRITER_APP_FILE` and `GOTCHU_GITHUB_WRITER_INSTALLATION_ID` only for the executor service. Reader tokens, webhook secrets, and web authentication credentials are not passed to it.

The action provider exposes four separately checked operations: `reconcile`, `publishBranch`, `openPullRequest`, and `verify`. Before publishing, it recomputes the complete candidate tree from the approved base and artifact. On a timeout the executor reconciles remote refs/PRs before retrying. It permits a bounded retry only when reconciliation proves the effect was not applied and `assertWritable` succeeds again. Unknown results remain uncertain; duplicate deliveries do not create another PR. A provider response alone never yields `verified`: remote action branch, parent, base, candidate tree, deterministic dependency commit (when applicable), draft state, and PR URL all must match.

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

`test:postgres` starts disposable PostgreSQL 17.11 and Redis 7.4.11 containers on random loopback ports with random credentials and temporary storage, then removes only those named containers. It tests durable outbox/job approval, real Postgres leases and attempt history, Redis duplicates, and injected result loss after branch creation, PR creation, and verification. Other tests cover missing approval, revoked credentials, stale base, closed PR, and unknown remote state. The opt-in GitHub run was completed on 2026-10-24 against the authorized sandbox: [source-patch draft #36](https://github.com/0bkevin/gotchu-pr-sandbox/pull/36) and [D06 dependency draft #37](https://github.com/0bkevin/gotchu-pr-sandbox/pull/37) both passed remote tree/digest verification and duplicate-delivery reconciliation, then were closed and their branches deleted. D06 resolved a live OSV npm advisory, verified the exact package tarball and lockfile artifact, and ran the candidate suite in Firecracker. Non-npm scanner adapters, WebAuthn, and the source-patch validation attestations remain fixtures. These checks do not establish live WebAuthn enrollment or a production rollout.

The Postgres/Redis crash tests use an injected provider and fixture WebAuthn/validation attestations. Only the opt-in GitHub case demonstrates a live provider write and exact tree verification. These checks do not prove live WebAuthn enrollment, VM isolation, production operations, merge, or deploy.
