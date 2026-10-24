# `@gotchu/scenarios`

This package supplies versioned, evidence-selected remediation recipes and a bounded source-candidate preparer. It never asks a model to invent commands, writes to a repository, runs customer code, rotates credentials, or claims a correction is verified.

## Frontend and HTTP contracts

Import `@gotchu/scenarios/contracts` from browser code. It has no Node or TypeScript compiler imports. Its main exports are:

- `reportRecommendationsParamsSchema` / `ReportRecommendationsParams` for `GET /reports/:reportId/recommendations`.
- `reportRecommendationsResponseSchema` / `ReportRecommendationsResponse` for the report-scoped recommendation response.
- `prepareCorrectionRequestSchema` / `PrepareCorrectionRequest` for `POST /reports/:reportId/corrections`, with `recipeId`, `findingId`, and `expectedSourceDigest`.
- `prepareCorrectionResponseSchema` / `PrepareCorrectionResponse` for `{ sourceId, jobId, changes: [{ path, description }], patchHash }` after the server stores a new candidate snapshot and queues a rescan.
- Recipe, recommendation, coverage, and repository-context schemas and types, including `remediationRecipeCatalog`.

The correction response contains only a sanitized change description and hash. It does not contain source, diffs, secret values, or the private preparation payload.

## Server preparation

Import `@gotchu/scenarios/server` only from a trusted server. `buildRecipeRecommendations(runInput: CustomerRunInput, report: CustomerAssessmentReport)` validates the shared runtime schemas, recalculates the source digest, and binds the report to tenant, application, job, mode, source snapshot/digest, evidence snapshot references, and authorized target version/origin. The route should load the persisted report by ID inside the authenticated tenant scope; never accept report data from the request body. Recommendations preserve finding severity, confidence, exploitability, IDs, and scope. They use fixed recipe options and report whether a candidate patch, guided review, or an integration is available.

`prepareCandidatePatch(runInput: CustomerRunInput, report: CustomerAssessmentReport, request: PrepareCorrectionRequest)` requires the request’s `expectedSourceDigest` to match the report-bound snapshot. It prepares at most one candidate and returns `CandidatePatchPreparation`, including the private candidate source snapshot, the original file checksum, exact before/after bytes, a hash bound to recipe/report/finding/source, and sanitized `{ path, description }` changes. It has no storage or queue side effects. The backend must store the candidate as a new source, queue the independent rescan, then use `correctionResponseForQueuedScan` to create the public response.

The candidate snapshot is private customer source. Pass it only to the trusted backend that stores the new snapshot. Do not log it, include it in ordinary summaries, or send it to the browser. Preparation is not approval, repository write, test execution, production deployment, or verification.

## Candidate transformations and coverage

- JavaScript/TypeScript: TypeScript parses the exact report-bound file. Only one `rejectUnauthorized: false` object property in that file can become `true`. A reported property/value line selects among multiple candidates; a single AST candidate is accepted when the scanner anchors its enclosing object. Comments, strings, computed properties, syntax errors, and ambiguous locations do not produce a patch.
- Kubernetes YAML: only a unique exact `privileged: true` or `allowPrivilegeEscalation: true` scalar directly inside a `securityContext` mapping can become `false`, and only when the finding line identifies that scalar. Quoted values, multiline scalar text, ambiguous plain text, comments, unsupported syntax, and duplicate keys are not rewritten.
- Evaluation and shell findings remain guided review. Dependency fixes require a verified fixed release and lockfile-aware validation. Credential rotation requires an authorized issuer integration; source cleanup alone is not rotation.

Repository context reads only dependency names from literal `package.json` dependency sections and recognized configuration paths. It does not inspect imports, infer behavior, load configuration, or execute content. Manifest/configuration states expose missing, partial, or capped context. Detector availability is distinct from report coverage: a detector can exist while a particular assessment’s coverage is unknown or not requested. Authentication failure detection exists outside customer assessment reports; route enumeration, application error, resource-pressure, and provider-outage detectors are not implemented here. Individual OWASP references do not imply broad category coverage.

## Checks

The focused suite exercises report and tenant binding, source digest integrity and size caps, external-only assessments, architecture hints, TypeScript AST matching, exact YAML matching, ambiguous/opaque YAML, integration-gated actions, and the sanitized HTTP response contract.
