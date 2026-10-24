# Verification record


## Continuous monitoring and dashboard corrections — 2026-10-24

This milestone supersedes the manual-only capability descriptions below. All checks use local development infrastructure; no AWS deployment, live customer GitHub/provider availability guarantee or production write is claimed.

| Check | Observed result |
| --- | --- |
| `pnpm check` | Workspace build, strict typechecks and default package suites passed: 329 tests passed and 128 infrastructure-gated cases were explicitly skipped at that checkpoint. Later claim/provider fixes were covered by the focused and live commands below; these counts are not a final unique-case total. |
| Final `pnpm typecheck` | Passed across the entire workspace and root integration-test project after the final claim/provider fixes. |
| `pnpm --filter @gotchu/database test:postgres` | **115 passed**: 12 database and 103 backend cases, including 107 actual PostgreSQL checks and 8 units. Covers monitoring RLS/leases/materialization, signed telemetry lifecycle, exact correction atomicity and migration 013 claim settlement. Synthetic scanner/status/MFA ports are labeled fixtures. |
| `GOTCHU_TEST_SCANNERS=1 pnpm test:integration` | **52 passed, zero skips** against fresh PostgreSQL/Redis, actual BullMQ, built Nitro/coordinator processes, Auth.js cookies, HMAC scanner, cached Docker tools, real OSV metadata and controlled DNS/TLS. Includes all six assessment combinations plus an exact TLS correction and actual independent rescan. |
| Final monitoring/provider checks | Monitoring **21 tests passed**; coordinator/monitoring source+test typechecks and builds passed. The subsequent scheduled-monitoring integration rerun passed **4/4**, including simultaneous known Railway outage and separate unknown coverage. Provider feeds are synthetic fixtures, not live provider availability evidence. |
| Web checks | **60 tests passed**, including recommendations/selection contracts, same-origin APIs, no caller authority overrides and alert response handling. Actual API+Postgres regressions verify acknowledgment/resolution and refreshed session cookies. |
| Packaging | `docker build --check .` and normalized all-profile Compose policy checks passed. Updated images were not built or deployed; disk pressure made a full image rebuild inappropriate. Native Node compiled runtime behavior was checked separately. |
| Development lifecycle/browser | `pnpm dev:start` reached actual scanner/coordinator/web readiness. Chromium registered a fresh account, created a workspace/app, sent authenticated telemetry, acknowledged an alert, checked advisory capacity readiness, uploaded a source folder, confirmed a private correction, observed its rescan, disabled telemetry and signed out. Desktop and 390px mobile layouts had no horizontal overflow or displayed application errors. Signing keys were hidden before captures. |

The full integration run precedes the last mixed-provider coverage fix; the four-case live scheduler rerun and 21 adapter tests cover that final change. Counts overlap and must not be added as unique cases. The updated backend suite includes the newer eleven monitor-claim settlement cases even though they were not present when the default checkpoint collected its skipped tests.

The process integration found two real integration defects: bundling TypeScript's CommonJS compiler into Nitro ESM broke runtime readiness, and Semgrep's `profile.` rule prefix prevented recipe matching. Native compiler tracing and exact known-prefix matching fix both. The actual scanner-to-button-to-rescan path passed after those fixes, without changing the original snapshot or claiming behavioral tests.

Independent Astra reviews drove fixes for alert quota isolation, permanent projection settlement, acknowledged-alert responses, GitHub aggregate memory limits, Railway freshness/mixed evidence, Git submodule exclusion, recovered unknown monitoring, current-revision coverage, distinct dependency versions and revoked monitor claims. The fourth scoped review reported no findings; its conclusion is code-review evidence, not an independently rerun live suite.

Provider writes, production MFA/approval adapters, behavioral customer tests, complete dependency-source auditing, broad company asset discovery, external notifications, VM-class execution isolation, measured capacity, retention maintenance and recovery drills remain unavailable or unproven. In-app triage and self-reported migration checklists do not establish completed remediation or migration. The production Semgrep profile gate remains closed.

## Actual customer application in development — 2026-10-24

This record supersedes the fixture-only milestone below. The product now accepts customer-created accounts, workspaces, applications, source snapshots, and DNS-verified public HTTPS origins. The fictional application remains a regression target. No cloud deployment was performed.

### Current verification

| Check | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm peers check` | Frozen workspace resolution passed; no peer issues. Existing approved build dependencies were already available. |
| `pnpm build` and `pnpm typecheck` | All workspace builds and strict source/test checks passed, including the root integration-test project. The final coordinator guard also passed its focused rebuild/typecheck. |
| `pnpm test` | **256 passed**, with 99 database-gated cases explicitly skipped by the default command. Live commands below cover those boundaries separately. |
| `GOTCHU_TEST_SCANNERS=1 pnpm test:integration` | **42 passed, zero skips**: five actual customer-process cases, four persisted local account/Auth.js cases, 14 event/investigation cases, and 19 retained fixture regressions. The heavy customer case completed all six internal/external/combined and before/after combinations. |
| `pnpm --filter @gotchu/database test:postgres` | Parent run passed 11 database + 58 backend cases. After the target-fencing change, the isolated backend agent reran the same command: **11 database + 64 backend cases passed**, including 24 customer cases. That final backend run is delegated evidence, not an independently repeated parent run. |
| `pnpm --filter @gotchu/coordinator test:live` | **7 passed**: five real Postgres/Redis cases with explicitly synthetic runner outcomes and two watchdog units. Includes uncertain transport outcomes and reclaimed claims with and without a configured scanner. |
| `pnpm --filter @gotchu/gateway test:postgres` | **23 passed**, including 18 actual PostgreSQL cases and the real HTTP worker/LangGraph path. TLS transport fixtures retained certificate verification. |
| `pnpm --filter @gotchu/executor test:postgres` | **35 passed**, including nine actual PostgreSQL ledger cases. Provider/MFA/eligibility ports remain explicitly synthetic. |
| `pnpm --filter @gotchu/customer-assessment test:live` | **4 passed**: actual pinned Docker profiles, malformed Trivy input with retained findings/unknown coverage, aborted Docker cleanup, and the actual OSV metadata service. No scanner findings were fabricated. |
| `bash scripts/infra-compose-validate.sh` and `docker build --check --progress=plain .` | Compose policy and Dockerfile checks passed. This is static image validation, not a build/run of the updated images. |
| `pnpm dev:start` / `pnpm dev:stop` | Started and verified actual scanner readiness, customer-discovery coordinator, web session API and rendered dashboard on loopback. Production-compiled assets run with explicit development registration. Stopped the recorded app processes without deleting data. |

Test counts in different rows overlap and must not be added as unique cases. The final full integration command used isolated PostgreSQL/Redis, built Nitro and coordinator processes, actual Auth.js callback cookies, HMAC scanner HTTP, a controlled authoritative DNS TXT server, and a verified local TLS fixture. The fixture-only TLS/private-IP exception is restricted to the test runtime; normal external assessment admits public addresses only. Real scanner/OSV evidence is an explicit opt-in and was enabled for this run.

### Customer behavior and negative cases

- Fresh registration, bad-CSRF rejection, encrypted Auth.js sessions, dynamic discovery of newly created workspaces, application isolation, immutable source/digest binding, and durable outbox/report completion.
- Independent external assessment without source, explicit internal-only scans, and combined evidence from uploaded source and authorized HTTPS. Version/advisory matches remain unassessed severity where severity was not fetched; they never establish reachability or exploitation.
- DNS TXT verification, consent/version/expiry binding, renewal/revocation, archive/restore, source deletion, admission limits, and cross-user/cross-application denial.
- The process test pauses the HTTPS DNS lookup before opening TLS. Both revoke and renew return 409 while the probe is outstanding; successful revocation follows settled work. Queued work for an archived app performs no GET. Expiry tests independently prove zero connections after authorization expires during DNS.
- Unknown remote scanner outcomes and reclaimed customer claims are quarantined rather than replayed. Quarantine continues to block target mutation after a job fails. Even a restart without scanner configuration preserves this fence. No customer route clears it; an operator must establish quiescence before reconciliation.
- Cancellation observes started promises, retains scanner admission until cleanup settles, and latches cleanup faults. Readiness is coalesced and bounded. Trivy omissions remain unknown while valid findings survive.

Astra review rounds found and drove fixes for the auth runtime/transport bridge, scanner lifecycle/coverage limits, post-DNS expiry, target revocation races, and recovery ordering. The final narrow review of `225c3d6` reported no findings by inspection. Review checkouts lacked dependencies; their review conclusions do not substitute for the live runs above.

### Browser and launcher verification

An actual Chromium client registered accounts, created a workspace/application, selected a real source folder, uploaded a snapshot, started an internal assessment, and opened the persisted report and evidence. Real Semgrep, Gitleaks, Trivy and OSV observations appeared; the test secret value was absent from the rendered evidence. A subsequent two-account sign-out/sign-in check showed an empty new workspace with no prior account's workspace or project data. At 390 CSS pixels the report had no horizontal overflow. Desktop/mobile captures are ignored local artifacts under `.local/dev`.

T3 browser automation was explicitly unavailable under the host AppArmor configuration, so the installed headless Chromium was used without changing host security settings. The owned browser was closed after verification. The dashboard HTML is also checked through the actual built HTTP process, and the launcher refuses to report ready if that page fails to render.

The first broad runs exposed two test-harness errors: a case-sensitive assertion expected lowercase branding while the SSR title uses “Gotchu”, and a synthetic hanging adapter depended on an unref'ed abort timer to keep a standalone child alive. The assertions now use the actual route title, and the child fixture owns a referenced handle like the live server. Focused checks passed after correction; no production check was weakened or suppressed.

### Remaining release gates

This establishes the implemented development customer path, not a production release. Semgrep 1.90.0 remains enforced development/test-only until a maintained pin is validated. Customer-code execution stays disabled pending VM-class isolation. Live AWS/OAuth, production ingress TLS, MFA, provider writes, alerts, restoration drills, measured retention/capacity/cost, invitation management, and broader scanner profiles are not established. Model calls and provider writes remain disabled. The updated coordinator image dependency layout passed Dockerfile checks but was not rebuilt because local Docker storage had less than 0.5 GiB free; no unrelated data/images were pruned.

The production web build reports upstream Nitro/Rolldown `use client` warnings; these are not suppressed. There is no lint script.

## Earlier controlled assessments and AWS direction — 2026-10-24

The current milestone is a controlled demonstration with real source/HTTP assessments and a usable dashboard, rather than the earlier scanner-plus-approved-PR demonstration. The older foundation record below remains historical evidence. General customer scanning, response automation and cloud deployment remain separate gates.

| Command | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed after integrating the AWS and assessment dependencies. |
| `pnpm peers check` | No peer dependency issues. |
| `pnpm check` | All workspace builds, strict source/test typechecks and integration-test typechecks passed; 157 package cases passed. Default tests explicitly skipped 69 database-gated cases. |
| `pnpm --filter @gotchu/database test:postgres` | 47 passed: 7 database cases and 40 backend cases, including 39 actual Postgres checks and 8 units. |
| `pnpm --filter @gotchu/coordinator test:live` | 5 passed: 3 actual Postgres/Redis delivery cases with explicitly synthetic report adapters and 2 watchdog units. |
| `pnpm --filter @gotchu/gateway test:postgres` | 23 passed, including 18 actual Postgres cases and real HTTP worker/LangGraph integration. Separate transport tests use a fixture service with TLS certificate validation enabled. |
| `pnpm --filter @gotchu/executor test:postgres` | 35 passed, including 9 actual Postgres ledger checks. Provider, MFA and eligibility adapters remain labeled fixtures. |
| `pnpm test:integration` | 33 passed: the existing 14 pipeline cases plus 19 controlled-assessment cases using real Postgres, Redis/BullMQ, the assessment runner and HTTP target. The demo API uses the production handler and binding behind a test-only Node HTTP bridge. |
| `pnpm --filter @gotchu/web typecheck` and `test` | Passed again after the optional OIDC-name fix; 25 web cases passed. |
| `scripts/infra-compose-validate.sh` | Default Compose boundary, opt-in demo, optional identity settings and private target-port checks passed. |
| `scripts/infra-live-check.sh` | Built and booted real web/coordinator images; checked both bundled assessment revisions inside the nonroot, read-only coordinator image with external networking disabled. Both source and loopback HTTP profiles completed. Persistent Postgres/Redis restart, repeatable role bootstrap, loopback bindings, unavailable-auth readiness, verified HTTPS egress, disabled profiles, graceful shutdown and isolated-project cleanup passed. |

Across the package and live suites, 259 distinct cases passed, including 102 cases using real Postgres. Repeated units inside live commands are counted once. The live runners used temporary isolated databases, generated credentials, random loopback ports and cleanup; they did not reuse the local demonstration volumes or customer data. Pulumi's three cases use mocks, not AWS.

### Behavior exercised

- All six mode/revision combinations persist validated reports and evidence. Exact idempotent retries and repeated delivery produce one durable result. Revoked targets and stale leases cannot persist a successful report.
- Public callers cannot select another tenant/application, target, URL, path or response mode. The reserved demo principal cannot use general customer operations. Database constraints, RLS and atomic completion remain authoritative.
- Source and HTTP are independent: external mode completes with a repository port that rejects every access. Internal mode does not make HTTP requests. Redirects, hanging reads, oversized/incomplete responses and unavailable evidence retain limits or degraded coverage.
- The vulnerable fixture produces three source findings and two HTTP observations. The corrected fixture produces no source findings and retains its informational fictional banner. This is a narrow deterministic profile; an advisory declaration is not proof of installation, reachability or exploitation.
- Demo admission is serialized durably: three unfinished jobs and 100 lifetime jobs. API rate tests additionally cover the per-process 10-new-key rolling-minute and 30-POST fixed-window caps, including concurrent requests and exact retries.
- Two scoped Astra review rounds found and resolved OIDC subject-length and partial-analysis classification issues. The second round found no material remaining defect. Distinct maximum-length OIDC subjects map to bounded issuer/client-scoped principals; incomplete opposite coverage cannot justify a one-sided comparison. These are code/session-fixture checks, not live OAuth.

### Actual dashboard verification

The built Nitro web process and coordinator ran against the worktree's own local Compose data services. A Chromium client exercised all six mode/revision combinations through the actual web routes over TCP, report history, comparison filters, native evidence dialogs and Escape dismissal, coverage, JSON download, and direct navigation between the two combined reports used by the revision comparison. The downloaded JSON passed the report schema. A coordinator/web restart retained the reports. At 390 CSS pixels the page had no horizontal overflow and all four navigation controls remained visible. Blocking the API in the browser produced an error state with assessment submission disabled; restoring it recovered the report list. No browser exceptions were observed.

The T3 collaborative browser and HTML-preview tools were unavailable because of the host AppArmor policy. A locally installed headless Chromium provided the browser checks without changing host security settings. Browser captures and process metadata are ignored local artifacts under `.local/demo`.

### Remaining limits

No AWS preview/deployment, live OIDC/GitHub OAuth exchange, production MFA, model/provider calls, customer repository enrollment, general scanners, disposable customer-code VMs, deployed TLS, recovery drill, production retention/capacity/cost or alerts are established by these checks. The assessment is observation-only; provider writes remain frozen. The current demo quotas are implemented bounds, not measured production throughput or global customer quotas. CI steps are committed; remote Actions results are separate evidence.

The web build still reports upstream Nitro/Rolldown `use client` directive warnings; these are not suppressed. No lint script is defined.

## Earlier foundation verification — 2026-10-24

The integrated foundation passed its workspace build, strict typechecks, package tests, and isolated database/queue/HTTP suites. These checks establish the implemented local boundaries; they do not establish production readiness or the full product demonstration.

### Checks run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed with Node 24 and pnpm 11. |
| `pnpm peers check` | No peer dependency issues. The workspace pins a compatible OpenTelemetry API range for Pulumi's tracing SDKs. |
| `pnpm check` | All workspace builds and typechecks passed; 92 package tests passed. The default test command explicitly skipped 55 PostgreSQL cases without a test URL. |
| `pnpm --filter @gotchu/database test:postgres` | 36 passed: 7 database and 29 backend cases. Includes 28 real PostgreSQL cases and 8 units. |
| `pnpm --filter @gotchu/gateway test:postgres` | 23 passed: 18 real PostgreSQL cases, 3 configuration cases, and 2 actual Node HTTP/TLS transport cases using a fixture service. Certificate validation stayed enabled. |
| `pnpm --filter @gotchu/executor test:postgres` | 35 passed: 9 real PostgreSQL integrations and 26 orchestration/adapter cases. Provider and MFA inputs were fixtures. |
| `pnpm test:integration` | 14 passed against fresh PostgreSQL and Redis containers, including the actual HTTP gateway, HTTP worker, LangGraph, reserved deterministic delivery lane, and recovery behind an investigation backlog. |
| `pnpm exec tsc -p test/tsconfig.json` | Integration tests and their web/database boundaries passed strict checking. |
| `git diff --check` | Passed before the focused implementation commits. |
| `scripts/infra-live-check.sh` | Real web/coordinator images built and ran nonroot with read-only roots. Persistent data survived restart; both role-bootstrap passes, loopback binds, readiness, GitHub TLS, disabled profiles, graceful shutdown, and cleanup checks passed. |

Across these suites, 161 distinct test cases passed, including 69 that use real PostgreSQL. Repeated executions of the same case are not counted twice. Live runners use generated credentials, random loopback ports, isolated test databases, and cleanup in `finally`; they do not reuse customer data or existing database volumes.

### Important failure cases exercised

- Tenant and application scope, forged identity headers, signed intake, repeated delivery, concurrent UUID-equivalent replay, and atomic event/outbox persistence.
- Lost, completed, or failed Redis delivery records with unfinished durable Postgres intent.
- A newly accepted signed event finishes while two investigation fixtures remain blocked and a third waits, through both outbox delivery and reconciliation using the production transport factory.
- Atomic run/job completion, rollback after an injected final write failure, stale lease rejection, and recovery after a terminal checkpoint was saved but the coordinator stopped before finalization.
- Concurrent aggregation without incident-count regression. Signed year-zero timestamps are rejected; legacy incompatible timestamps remain retained, are excluded from detector windows, and keep coverage degraded.
- Expired and revoked capabilities, checkpoint scope/version checks, durable read idempotency, bounded input, tool budgets, and gateway TLS certificate validation.
- Exact approval identity, role revocation, one-use execution claims, frozen recovery, uncertain-outcome settlement, and executor retries through the real ledger.
- The model endpoint returns `503 model_not_configured`; the HTTP pipeline records a delayed investigation and zero model calls/spend.

Three Astra review rounds identified seven coordinator/HTTP issues. Focused commits and regressions address them; the final review reported no material remaining defect in the timestamp/quarantine and checkpoint-recovery changes. That was a scoped code review, not a production security assessment.

A subsequent architecture check found that investigations shared all event-processing slots. A separate deterministic queue now reserves one slot independently of the two investigation slots per coordinator. Recovery also selects a bounded batch per lane, so an investigation backlog cannot hide event jobs. Live regressions cover normal publication, transport recovery, and a backlog larger than a recovery batch; stop the old shared-queue coordinator before upgrading.

The built Nitro server was also started on a temporary loopback port: the homepage and liveness route returned 200, and missing database/auth configuration returned 503. Its process was stopped after the probe. Compose intentionally reports unready for missing OAuth or organization assignment; unavailable MFA and investigator setup remain explicit capability fields.

The final coordinator image was rebuilt after the recovery-selector change and loaded its transport/recovery exports as UID 1000 with networking disabled and no data credentials. The pipeline's intake leg uses the production Request/Response adapter through an injected SDK fetch; gateway/worker legs use real HTTP sockets. A positive signed-event POST through the built Nitro host over TCP was not part of these checks.

### Limits of this evidence

OAuth callbacks against a live GitHub application, production MFA and trusted eligibility verifiers, real model/provider calls, GitHub PR writes, scanner execution, disposable customer-code VMs, deployed gateway/worker TLS, backups/restoration, quotas/retention, alert delivery, representative-traffic calibration, capacity, latency, and operating cost remain unproven or unimplemented. Pulumi policy tests use mocks; no cloud resources were deployed. CI configuration is committed, but remote GitHub Actions results have not been claimed.

The first full product demonstration still needs the vulnerable-dependency scanner path and an approved tested GitHub PR. Current tests prove the event/investigation foundation and execution authorization ledger using explicitly labeled external fixtures.

The production web build emits upstream Nitro/Rolldown warnings about bundled `use client` directives. The build passes; these warnings have not been suppressed. No repository lint script is defined.
