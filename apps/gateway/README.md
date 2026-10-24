# Authenticated investigation gateway

This independent Node service is the investigation worker's only data boundary. It verifies Ed25519 RunCapability tokens with a public key, then checks persisted tenant/application/run scope, the durable job, deadline, and revocation state in Postgres. The worker receives neither a database URL nor provider or integration credentials. Model calls are disabled with `503 model_not_configured`; they never reserve budget or contact a provider.

## Build and configure

Requires Node 24, pnpm 11, and the integrated `@gotchu/agent`, `@gotchu/worker`, backend, contracts, and database packages. Build workspace dependencies before this package. Runtime exports include `loadGatewayConfig`, `createGatewayService`, `createGatewayHttpHandler`, `startGatewayServer`, `startGateway`, and `revokeRunCapability`. Operator migration code is separately exported from `@gotchu/gateway/migrate`.

```sh
pnpm --filter @gotchu/gateway... -r --sort build
pnpm --filter @gotchu/gateway typecheck
pnpm --filter @gotchu/gateway test
pnpm --filter @gotchu/gateway test:postgres
```

The gateway needs its **own** login provisioned as a member only of `gotchu_coordinator`. `startGateway` constructs `createDatabase` and checks the login before opening a port. Owner, superuser, bypass-RLS, and mixed service-role logins fail. No agent-facing method exposes that database object, generic queries, credentials, approvals, or provider writes.

Configuration:

- `GOTCHU_GATEWAY_DATABASE_URL`: restricted gateway login, separate from the coordinator's credentials.
- `GOTCHU_RUN_CAPABILITY_PUBLIC_KEY`: Ed25519 SPKI PEM; literal `\n` escapes are accepted. Private capability signing keys are rejected and belong only to the coordinator.
- `GOTCHU_GATEWAY_TLS_CERT_FILE` and `GOTCHU_GATEWAY_TLS_KEY_FILE`: server TLS certificate and private key paths. TLS 1.2 or newer is required. This TLS key is unrelated to capability signing.
- `GOTCHU_GATEWAY_HOST`: `127.0.0.1` by default; also accepts `::1`, `0.0.0.0`, or `::` with TLS.
- `PORT`: 3002 by default.
- `NODE_ENV`: production by default. Only `development` or `test` plus `GOTCHU_GATEWAY_ALLOW_LOOPBACK_HTTP=true` permits HTTP, bound to literal `127.0.0.1` or `::1`. Containers that need a non-loopback bind must use TLS. Proxy headers cannot relax this boundary.

Use `GOTCHU_GATEWAY_URL=https://...` in the worker, with a certificate trusted by its Node runtime. No code disables TLS certificate validation. Browser `Origin` requests are rejected; there are no cookie, CORS, unauthenticated health, or public gateway routes. TCP/TLS process probes are suitable for liveness; readiness requires applying migrations and exercising an authorized run.

Requests have a 32 KiB streamed body cap, 20 KB header cap, five-second header timeout, fifteen-second overall timeout, and two-second idle keep-alive. Responses omit exception details, use `no-store`, and stay below the worker's 40 KiB response bound. Database queries also inherit the database package's timeouts. A timed-out mutation can have committed; retries must use the same read identity or reload checkpoint version.

## Migrations and revocation

Apply the backend/database migrations first, then invoke `migrateGateway({ connectionString: operatorUrl })` or run `pnpm --filter @gotchu/gateway migrate` with `GOTCHU_MIGRATION_DATABASE_URL`. Never configure operator credentials in the gateway runtime. Migration `001_read_calls_and_revocations.sql` is checksum checked, transactionally applied, owned by `gotchu_owner`, and uses FORCE RLS. It creates a bounded per-run read ledger and a revocation table; runtime access is limited to coordinator SELECT/INSERT.

Trusted coordinator/operator code can call `revokeRunCapability(database, { organizationId, runId, jti })`. This has no HTTP endpoint. Revocation locks the run, serializing with ongoing gateway work; requests that finished before revocation remain committed, and later requests fail, including checkpoint reads. Expiry is rechecked after acquiring locks. Revoke before exposing newly recovered state after a restore; revocation durability, like all ledger state, depends on recovery procedures.

## Durable input and HTTP contract

Every endpoint requires `Authorization: RunCapability <token>`. The shared agent schema enforces issuer `gotchu-run-capability-issuer`, audience `gotchu-investigation-worker`, EdDSA, subject equal to run ID, UUID scopes and jti, and a maximum ten-minute lifetime. The gateway additionally requires expiry no later than the persisted run deadline. Caller IDs only select data inside this authenticated scope.

The coordinator persists exactly `{ incidentId: UUID, evidenceIds: UUID[1..20] }` in the investigation job. The gateway exports `gatewayJobPayloadSchema`. `gotchu.incidents.evidence` is an array of event UUIDs, with rule ID `auth.login_failures.v1.account` or `auth.login_failures.v1.ip`. The trusted coordinator establishes the threshold/group/window; this gateway checks that the incident and every selected event belong to the run's application and that selected IDs occur in both incident evidence and capability scope. Events must have authenticated application provenance from a `signed_events` integration. Ambiguous event IDs across integrations fail closed.

The server derives integrity, tenant, and provenance checks from these records. An open supported incident with matching failed-login evidence is a deterministic candidate. Resolved or unsupported evidence is unavailable, never an assertion that a scanner inspected it. Empty/missing evidence is unavailable. Required checks are not accepted from requests.

Under `/internal/v1/agent-runs/:runId`:

- `POST /input`, body `{organizationId,applicationId}` → the agent's `InvestigationInput`.
- `POST /reads`, body `{organizationId,applicationId,callId,callType,name,evidenceId}`, with `Idempotency-Key: callId` → bounded `EvidenceRecord`.
- `GET /checkpoint` → `{version,checkpoint:null|SafeInvestigationCheckpoint}`.
- `PUT /checkpoint`, body `{organizationId,expectedVersion,checkpoint}` → `{version}`.
- `POST /model-calls`, body `{organizationId,applicationId,reservationId,systemInstruction,userContext,maxOutputTokens,remainingTokens,remainingSpendMicroUsd}`, with `Idempotency-Key: reservationId` → `503 model_not_configured`.

All work and checkpoint writes require a running run, live deadline, running job, and live job lease. Failed jobs cannot continue work even if a model reservation kept their run open. Valid scoped grants can read terminal checkpoints; expired or revoked grants cannot.

Only `evidence.read` and `auth.events.read` return data. Repository/inventory reads are explicitly unavailable, and no scanner, repository, or cloud adapter exists. Evidence includes scope IDs, fixed source, recorded `received_at`, and a small JSON excerpt containing only the event type, outcome, and recorded `payload_hash`. Actor/account/IP, attributes, resources, incident summaries, and raw payloads are excluded; `truncated:true` makes that minimization explicit.

Required evidence reads must use `evidence.read` and the worker's deterministic UUID derived from SHA-256 of `runId + NUL + required-evidence + NUL + evidenceId`. They can only retrieve the fixed job evidence; they do not consume additional-read budget. Additional calls invoke the real `backend.runs.consumeTool` in the same transaction as their durable ledger insert, with an eight-call limit. Identical retries return the saved minimized response without spending again; a changed request under the same ID returns 409. Restarting the gateway, changing jti, or falsifying checkpoint counters cannot reset the ledger. Read replays still require a current grant, active run/job, and currently resolvable scoped evidence.

Checkpoints must match `safeCheckpointSchema` and run scope; citations must belong to both job and grant. Unknown/raw fields are rejected. Free-text result summaries are replaced with a fixed sentence, and counters come from backend state (tokens/spend are zero while models are disabled). `sequence` must equal `expectedVersion + 1`; the backend's version fence makes concurrent saves conflict. Checkpoint enums are untrusted agent progress and cannot authorize work, approval, or execution. Client-provided remaining budgets and counters never authorize model or read work.

## Validation and release gates

`test:postgres` starts its own disposable `postgres:17-alpine` container with a random loopback port/password and temporary storage, provisions separate logins, and removes the container afterward. The live suite uses real signed intake, RLS, backend APIs, gateway HTTP, the worker HTTP endpoint, and actual LangGraph. It verifies tenant boundaries, fixed evidence scope, read replay and atomic rollback, checkpoint fencing/sanitization, expiry/revocation, job/run liveness, and disabled model spending. Without `GOTCHU_TEST_DATABASE_URL`, live tests explicitly skip. The separately tested TLS transport uses an ephemeral self-signed certificate, explicit CA validation, and a fixture service; it is not deployed certificate validation.

This does not prove live model integration. There is no model adapter or injection bypass, no provider credentials, and no provider call. Enabling one is separate work requiring independently bounded worst-case `reserveModel` before I/O, `settleModel`, explicit opt-in, validated usage/pricing, cancellation and uncertain-outcome handling, and no blind retry of a used reservation.

Remaining production gates include coordinator integration, deployment certificates and private networking, run issuance/revocation operations, migration/credential provisioning, measured admission/rate limits and retention, restore/revocation recovery drills, and unavailable scanner/provider adapters. Customer-code execution and provider writes remain disabled.
