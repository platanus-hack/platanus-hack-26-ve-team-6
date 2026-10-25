# Authenticated investigation gateway

This independent Node service is the investigation worker's only data boundary. It verifies Ed25519 RunCapability tokens with a public key, then checks persisted tenant/application/run scope, the durable job, deadline, and revocation state in Postgres. The worker receives neither a database URL nor provider or integration credentials. Model calls use the workspace's saved provider preset and secret, require persisted consent, and reserve and settle organization spend and token budgets. A separate signed gateway capability permits only the Owner-initiated connection probe; it carries no provider key.

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
- `GOTCHU_MODEL_SECRET_DIRECTORY`: private directory for the development file-backed provider-key store; Web and Gateway need the same protected store. Hosted deployments should supply an encrypted secret-store adapter.
- `GOTCHU_GATEWAY_MODEL_PROBE_SECRET`: optional shared secret, unpadded base64url encoded and at least 32 bytes, used only for the Owner connection-probe capability. Configure the same value in Web.
- `GOTCHU_CLAUDE_CODE_BIN`, `GOTCHU_CODEX_BIN`: optional paths to the official CLIs used by the Claude Code and Codex subscription presets; otherwise `claude` and `codex` are resolved on `PATH`. Each call runs in a fresh private home and empty working directory with all built-in tools disabled; only `PATH` and the credential reach the child. Codex logins are serialized per stored secret and rotated tokens are written back with the store's atomic `replace`.
- `GOTCHU_ALLOW_SELF_HOSTED_LLM_ENDPOINT=true`: operator-only opt-in to private custom model endpoints; without it, custom endpoints must use HTTPS and resolve only to public addresses.
- `PORT`: 3002 by default.
- `NODE_ENV`: production by default. Only `development` or `test` plus `GOTCHU_GATEWAY_ALLOW_LOOPBACK_HTTP=true` permits HTTP, bound to literal `127.0.0.1` or `::1`. Containers that need a non-loopback bind must use TLS. Proxy headers cannot relax this boundary.

Use `GOTCHU_GATEWAY_URL=https://...` in the worker, with a certificate trusted by its Node runtime. No code disables TLS certificate validation. Browser `Origin` requests are rejected; there are no cookie, CORS, unauthenticated health, or public gateway routes. TCP/TLS process probes are suitable for liveness; readiness requires applying migrations and exercising an authorized run.

Requests have a 32 KiB streamed body cap, 20 KB header cap, five-second header timeout, bounded operation timeouts, and two-second idle keep-alive. Responses omit exception details, use `no-store`, and stay below the worker's 40 KiB response bound. Database queries also inherit the database package's timeouts. A timed-out mutation can have committed; retries must use the same read identity or reload checkpoint version.

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
- `POST /model-calls`, body `{organizationId,applicationId,reservationId,systemInstruction,userContext,maxOutputTokens,remainingTokens,remainingSpendMicroUsd}`, with `Idempotency-Key: reservationId` → model JSON and settled usage. The worker validates the investigation output against its existing Zod schemas; the gateway returns a closed error and retains the reservation when cost is uncertain.

The separate `POST /internal/v1/model-probes` endpoint accepts `Authorization: GatewayProbe <short-lived HMAC token>` and `{organizationId,requestId}`. It rejects browser `Origin` headers, binds the token to both body IDs, deduplicates request IDs durably, sends a static prompt capped at 16 output tokens, validates `{ok:true}`, and settles actual usage against a 64-token organization reservation. Unknown usage remains reserved. It requires `GOTCHU_GATEWAY_MODEL_PROBE_SECRET` and does not accept model keys or prompts from the caller.

Provider-specific token limits, authentication, and JSON mode come from the versioned contracts catalog. JSON mode is sent only for catalogued models whose official API docs support it; other adapters rely on explicit JSON instructions and Zod validation. Investigation results still pass the worker's existing output schemas.

All work and checkpoint writes require a running run, live deadline, running job, and live job lease. Failed jobs cannot continue work even if a model reservation kept their run open. Valid scoped grants can read terminal checkpoints; expired or revoked grants cannot.

Only `evidence.read` and `auth.events.read` return data. Repository/inventory reads are explicitly unavailable, and no scanner, repository, or cloud adapter exists. Evidence includes scope IDs, fixed source, recorded `received_at`, and a small JSON excerpt containing only the event type, outcome, and recorded `payload_hash`. Actor/account/IP, attributes, resources, incident summaries, and raw payloads are excluded; `truncated:true` makes that minimization explicit.

Required evidence reads must use `evidence.read` and the worker's deterministic UUID derived from SHA-256 of `runId + NUL + required-evidence + NUL + evidenceId`. They can only retrieve the fixed job evidence; they do not consume additional-read budget. Additional calls invoke the real `backend.runs.consumeTool` in the same transaction as their durable ledger insert, with an eight-call limit. Identical retries return the saved minimized response without spending again; a changed request under the same ID returns 409. Restarting the gateway, changing jti, or falsifying checkpoint counters cannot reset the ledger. Read replays still require a current grant, active run/job, and currently resolvable scoped evidence.

Checkpoints must match `safeCheckpointSchema` and run scope; citations must belong to both job and grant. Unknown/raw fields are rejected. Free-text result summaries are replaced with a fixed sentence; model token/spend fields inside checkpoints stay zero, while authoritative usage comes from the backend ledger. `sequence` must equal `expectedVersion + 1`; the backend's version fence makes concurrent saves conflict. Checkpoint enums are untrusted agent progress and cannot authorize work, approval, or execution. Client-provided remaining budgets and counters never authorize model or read work.

## Validation and release gates

`test:postgres` starts its own disposable `postgres:17-alpine` container with a random loopback port/password and temporary storage, provisions separate logins, and removes the container afterward. The live suite uses real signed intake, RLS, backend APIs, gateway HTTP, the worker HTTP endpoint, and actual LangGraph. It verifies tenant boundaries, fixed evidence scope, read replay and atomic rollback, checkpoint fencing/sanitization, expiry/revocation, job/run liveness, and disabled model spending. Without `GOTCHU_TEST_DATABASE_URL`, live tests explicitly skip. The separately tested TLS transport uses an ephemeral self-signed certificate, explicit CA validation, and a fixture service; it is not deployed certificate validation.

The focused provider suite uses local TLS fixtures to verify each preset's request URL, headers, body shape, and parsed usage; a gateway fixture checks reservation settlement and replay. These are not live-provider evidence. `test/model-provider-live.test.ts` is opt-in and needs `GOTCHU_LLM_LIVE_TEST_CONSENT=true` plus provider-specific `GOTCHU_LLM_LIVE_<PROVIDER>_KEY` values. For the subscription presets, `GOTCHU_LLM_LIVE_CLAUDE_CODE_KEY` takes a `claude setup-token` token and `GOTCHU_LLM_LIVE_CODEX_KEY` the contents of a dedicated Codex `auth.json`; `test/subscription-cli.test.ts` covers the same adapters with fake CLIs. No provider credentials or live model runs are part of the default test environment.

Remaining production gates include coordinator integration, deployment certificates and private networking, run issuance/revocation operations, migration/credential provisioning, measured admission/rate limits and retention, restore/revocation recovery drills, and live-provider validation. Customer-code execution and provider writes remain disabled.
