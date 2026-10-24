# Independent executor integration contract

`@gotchu/executor` exports `createExecutor`, `ExecutionLedgerPort`, `ProviderAdapter`, runtime schemas, and the explicit `customerCodeExecutionEnabled = false` gate. The coordinator owns trusted queue claiming and may invoke the executor with a durable execution job. The executor does not run in an HTTP request handler, accept user identity headers, or receive model output as authorization.

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

## Typed ledger adapter requirements

The executor's port intentionally returns `unknown` for values that cross the adapter boundary; it validates each claim, stored execution, reconciliation result, and provider verification with Zod. The trusted adapter should use the exported complete `proposalSchema` from `@gotchu/backend` before mapping the backend claim to this port.

The backend adapter should map stale-head/policy/artifact rejections to `ExecutionLedgerError('stale_proposal')`, so the executor reports a stale proposal explicitly. The current backend contract also needs two small read/reconciliation operations for complete retry handling:

- `findByApproval({ organizationId, approvalId })` returns the existing durable execution identity and state, including `executionId`, `claimToken`, `actionHash`, recovery epoch, and the backend-validated proposal. The adapter maps the backend's `already_claimed` error to `ExecutionLedgerError('already_claimed')` and uses this restricted executor lookup.
- `resolveUncertain(...)` updates a previously terminal `uncertain` record after read-only provider reconciliation and independent verification. It can only settle `succeeded` or `failed`; it never authorizes another write.

The current `backend.executions.claim` is single-use, and `finish` records `succeeded | failed | uncertain` without automatic reclaim. A duplicate job never creates a second provider write. It reconciles the existing execution ID and returns the observed state. The parent adapter must provide those lookup/resolution operations before enabling a live provider adapter.

## Provider adapter

There is no production GitHub writer yet. If `ProviderAdapter` is omitted, `execute()` returns `disabled` before consuming approval or calling the ledger. The fake adapters in the tests are test fixtures only.

An enabled adapter must implement:

- `publish({ executionId, actionHash, proposal })`: make only the exact supported PR write, using `executionId` as provider idempotency identity;
- `reconcile({ executionId, actionHash, proposal })`: return strict `found`, `definitely_not_applied`, or `unknown` state after an ambiguous timeout;
- `verify({ executionId, providerReference, actionHash, proposal })`: independently inspect the provider and exact candidate artifact, returning the matching reference, action hash, base commit, and candidate commit.

On a publish timeout the executor reconciles before retrying. It permits one retry with the same execution ID only when reconciliation proves that the first request was not applied and `assertWritable` succeeds again. An unknown result is durably marked uncertain; duplicate deliveries only reconcile and never publish. A provider response alone never yields `verified`; independent post-write verification must match the exact action hash, base SHA, candidate SHA, and provider reference.

Customer-code execution has no implementation and stays disabled until a disposable VM-class boundary is independently demonstrated. This executor also does not enable a real GitHub adapter; repository automation safety, race handling, and exact artifact publication remain release gates.

## Validation limits

The Vitest suite injects fake ledger/provider ports to exercise orchestration, duplicate delivery, stale versions, uncertain outcomes, reconcile-before-retry, and provider verification. It does not prove the Postgres execution ledger or live provider behavior; the backend's Postgres checks and a separately validated real adapter remain required.
