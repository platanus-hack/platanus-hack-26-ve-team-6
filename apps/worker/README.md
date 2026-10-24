# Investigation worker integration contract

This process contains the bounded LangGraph investigator. It has no BullMQ consumer, Postgres or Redis connection, model provider key, integration credential, approval API, or provider write adapter. `apps/coordinator` owns durable queue claims and invokes the worker after claiming a stable `JobEnvelope`. A run capability is issued by the trusted coordinator/backend after it verifies the job lease. The worker receives only the capability.

## Process configuration and endpoints

Required configuration:

- `GOTCHU_RUN_CAPABILITY_PUBLIC_KEY`: Ed25519 SPKI PEM used only to verify capabilities. The worker never receives the signing key.
- `GOTCHU_GATEWAY_URL`: fixed gateway origin. HTTPS is required except for loopback HTTP in development or test.
- `PORT` (default `3001`) and `GOTCHU_WORKER_HOST` (default `0.0.0.0`).

If the public key is missing or invalid, startup fails with a stable configuration error. If the gateway URL is absent, the process can serve liveness, reports readiness as unavailable, and returns an explicit `integration_disabled` response to work requests. Gateway URLs cannot be supplied in an HTTP request.

| Method and path | Behavior |
| --- | --- |
| `GET /health/live` | Process liveness only. |
| `GET /health/ready` | `200` when a gateway origin is configured; otherwise `503` with `gateway_unconfigured`. This does not claim that external model processing is opted in. |
| `POST /v1/investigations` | Internal coordinator entry point. Requires `Authorization: RunCapability <compact-ed25519-jwt>` and an empty body. The signed claims supply the run scope; caller-selected run IDs, graph thread IDs, `x-user-id`, and input payloads are not accepted. |

The entry point is intended for the private service network. It does not authenticate an end user. The job lease and capability are established by the trusted coordinator.

## Run capability

The compact JWT uses `alg: EdDSA`, issuer `gotchu-run-capability-issuer`, and audience `gotchu-investigation-worker`. Its strict claims are:

```json
{
  "iss": "gotchu-run-capability-issuer",
  "aud": "gotchu-investigation-worker",
  "sub": "<runId>",
  "jti": "<unique capability id>",
  "iat": 0,
  "exp": 0,
  "organizationId": "<uuid>",
  "applicationId": "<uuid>",
  "runId": "<uuid>",
  "allowedReadTools": ["evidence.read", "auth.events.read"],
  "evidenceIds": ["<uuid>"]
}
```

`sub` must equal `runId`; `exp` must be in the future and no more than ten minutes after `iat`. The coordinator should make it expire with the durable run deadline. The gateway verifies the signature and scope on every call. A valid capability only authorizes the named read tools and evidence IDs for that organization, application, and run. It never authorizes approval, provider writes, or capability issuance.

## Fixed gateway paths

All gateway calls use the configured origin, the `Authorization: RunCapability ...` header, a JSON body where shown, bounded JSON responses, and the graph's abort signal. The worker follows redirects only as errors and never retries a provider/model mutation. Parent adapters may expose these paths over the coordinator's private HTTP API.

| Method and path | Request / response contract |
| --- | --- |
| `POST /internal/v1/agent-runs/{runId}/input` | Request: `{ organizationId, applicationId }`. Response is checked by `investigationInputSchema`: `{ scope: { organizationId, applicationId, runId }, requiredChecks }`. |
| `POST /internal/v1/agent-runs/{runId}/reads` | Request: `{ organizationId, applicationId, callId, callType, name, evidenceId }`. `callType` is `required_evidence` for deterministic preflight references or `additional` for a model requested read. Initially `name` is limited to `evidence.read` and `auth.events.read`. Response is an evidence record below. |
| `POST /internal/v1/agent-runs/{runId}/model-calls` | Request includes `{ organizationId, applicationId, reservationId, systemInstruction, userContext, maxOutputTokens, remainingTokens, remainingSpendMicroUsd }`. `reservationId` and `Idempotency-Key` are the same stable UUID. Response `{ output, usage }` is validated by Zod in the graph. The gateway must reserve model budget before provider invocation, enforce organization opt-in and run limits server side, and settle actual use. Remaining-budget values from the worker are hints, not authority. An uncertain or consumed reservation is reconciled by the gateway; it is never blindly repeated. |
| `GET /internal/v1/agent-runs/{runId}/checkpoint` | Response `{ version, checkpoint }`, where `checkpoint` is `null` before the first save. The adapter remembers `version` for this invocation. |
| `PUT /internal/v1/agent-runs/{runId}/checkpoint` | Request `{ organizationId, expectedVersion, checkpoint }`; response `{ version }`. The backend should use compare-and-swap on `expectedVersion` and enforce the run lease/deadline. |

The evidence record is strict and bounded:

```json
{
  "evidenceId": "<uuid>",
  "organizationId": "<uuid>",
  "applicationId": "<uuid>",
  "runId": "<uuid>",
  "source": "<bounded source label>",
  "collectedAt": "<ISO datetime>",
  "excerpt": "<at most 1200 characters>",
  "truncated": true,
  "authEvents": []
}
```

`requiredChecks` is also strict. Each evidence ID list is non-empty, unique within its check, and there can be at most twenty distinct IDs across all four checks:

```json
{
  "inputIntegrity": { "result": "passed", "evidenceIds": ["<uuid>"] },
  "tenantScope": { "result": "passed", "evidenceIds": ["<uuid>"] },
  "evidenceProvenance": { "result": "passed", "evidenceIds": ["<uuid>"] },
  "deterministicDetection": { "result": "candidate", "evidenceIds": ["<uuid>"] }
}
```

The first three results are `passed | inconclusive`; deterministic detection is `candidate | no_candidate | unavailable`. Missing evidence jobs must be returned by the gateway as unavailable/missing rather than fabricated evidence. The graph reports invalid or unsupported required input as inconclusive and does not call the model.

`authEvents` is optional and each event is validated by `authFailureEventSchema`; the deterministic aggregator groups opaque account references and IP addresses separately, deduplicates event IDs, and emits suspicious activity with `confirmedCompromise: false`. It uses fixed UTC ten-minute buckets and incident identity is stable as events arrive later in the same bucket. Blocked attempts are counted separately and are not compromise evidence.

The worker verifies each evidence record's ID, organization, application, and run against both the requested reference and the signed capability. Missing, malformed, unauthorized, or cross-tenant evidence produces an explicit inconclusive result. Evidence excerpts are sanitized and capped before model use. The organization model opt-in check belongs in the gateway because the worker is not trusted to establish consent.

## Budgets, checkpoints, and states

The investigator enforces at most four model calls, eight additional model-requested reads, 300,000 active milliseconds, 20,000 reported tokens, and USD 0.25 (`250000` micro-USD). Required evidence references are preflight inputs, not model-requested tool calls. The coordinator/gateway must independently enforce these budgets so a compromised worker cannot raise them. The model gateway reserves each call against the run before contacting a provider.

Checkpoints are run scoped and use the backend's monotonically increasing checkpoint version. They contain only version, scope IDs, phase, counters, and an optional bounded, redacted final result. They contain no capability, evidence excerpts, raw logs, or provider credentials. The graph has no production `MemorySaver`; its checkpoint contract is the injected gateway port. A checkpoint conflict or unavailable gateway returns delayed rather than proceeding as if persistence succeeded.

The model output schema permits only `candidate_issue`, `no_issue_supported`, or `inconclusive`, bounded summaries, supplied evidence citations, and the two initially supported read tools. Provider-write requests, invented citations, malformed output, and unsupported evidence are rejected. Every result carries `independentVerification: "not_verified"`; the model cannot approve or independently verify a finding.

## Coordinator/backend integration notes

The current backend run helper in `packages/backend/src/runs.ts` supplies `load` and optimistic `checkpoint`, plus `reserveModel`/`settleModel`. The parent-owned coordinator needs a private adapter that maps those methods to the paths above and issues capabilities only after claiming the durable investigation job. To preserve the graph's contracts:

- expose the scoped required-check descriptor and allow-listed evidence IDs from the current run;
- verify evidence existence and run ownership before returning records;
- add a stable per-call idempotency key to tool consumption, or otherwise deduplicate by `callId`; required evidence fetches must not consume the eight additional tool-call budget;
- bind each model reservation UUID to the run and ensure the per-run USD 0.25 ceiling in addition to the organization's budget;
- reject stale run leases, expired capabilities, stale checkpoint versions, model opt-out, and cross-tenant requests;
- never return model credentials or customer integration credentials to this process.

These HTTP adapters are integration boundaries, not a live Postgres/Redis verification. The worker's unit tests use injected fake gateways and do not replace the backend's live infrastructure checks.
