# Gotchu definition interview

Status: Rounds 1 through 5 accepted. The user subsequently selected TanStack Start and Auth.js and authorized parallel implementation with focused commits and infrastructure validation. The foundation is being implemented; production provider contracts, pilot measurements, and the unavailable detailed reference remain release gates.

## Sources and authority

- The user's product brief supplied in the conversation on 2026-10-24 is the starting specification.
- Detailed reference: `library-file:libfile_bc41f47b4608819199d3555887bfbac3`. Contents unavailable through the current tools; schemas, algorithms, and release tests in that reference have not been reviewed.
- Interview method: Matt Pocock's `grill-me` entry point and `grilling` skill, read from the upstream repository on 2026-10-24: <https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md>.
- Interview recommendations remain proposals until the user accepts them. The interview does not authorize implementation or deployment.

## Starting constraints from the brief

- Dashboard: Next.js/React, with TanStack Start as a supported alternative. API, workers, and executors remain separate from frontend routes.
- Original reference backend: TypeScript, Fastify, LangGraph JS, Postgres, BullMQ/Redis, and Better Auth. D21 supersedes the authentication choice with Auth.js; the public API's HTTP host is being reconsidered below. Runtime validation is required. Python substitution is possible only before implementation and must preserve external contracts.
- Initial integrations: selected GitHub JS/TS repositories, signed Node application events, scoped AWS resource metadata, and optional capability-aware Cloudflare telemetry.
- Required scanners: Semgrep CE, OSV-Scanner, Gitleaks, and Trivy configuration checks, with controlled profiles and visible coverage gaps.
- Deterministic checks and monitoring continue independently of bounded model investigations.
- Event acceptance requires authenticated integration context, tenant derivation on the server, transactional event/outbox persistence, and repeated-delivery-safe consumers.
- Evidence requires provenance, snapshot or commit binding, timestamps, tool versions, checksums, and retention deadlines. The model cannot grant verified status.
- Action proposals bind exact targets, parameters, evidence, versions, tests, and verification plans. Exact-hash approvals and execution validation are independent of the model.
- The initial write adapter opens tested GitHub PRs after approval. Merge, deployment, and containment are separate capabilities.
- Scanner workloads are isolated from the control plane. Executing customer tests or dependencies requires additional sandbox isolation.
- Tenant-aware data relationships, Postgres row security, quotas, freshness monitoring, external encrypted backups, and restoration testing are required.
- Pilot planning figures: five organizations, ten applications, one active scanner, two investigations, ten accepted events/second sustained, and a bounded 100 events/second burst. These are workload targets, not measured capacity.
- Initial retention targets: normalized events for seven days and incident evidence for thirty days. Model calls, data, and other costs require customer budgets.
- The two-VPS deployment and its compute estimate are reference assumptions. Availability, recovery, capacity, and total operating cost remain unproven.

## Decision tree to resolve

1. Customer and value: first buyer, operator skill, urgent job, alternatives, measurable benefit, pricing, and willingness to install integrations.
2. Product promise: assessment versus monitoring versus response; covered threats; exclusions; customer and operator responsibilities; alert expectations.
3. Authority and trust: solo-owner approvals versus two-person control; organization roles; fresh authentication; recovery; provider permissions; compromise boundaries.
4. Pilot scope: required integrations, delivery envelope, supported repository and deployment shapes, out-of-scope workloads, and hard release gates.
5. Onboarding and coverage: ownership checks, prerequisites, partial coverage, unsupported inputs, telemetry health, and time to first useful result.
6. Detection and investigation: event contracts, identity and time semantics, replay behavior, aggregation, late data, thresholds, incident lifecycle, evidence standards, budgets, and human escalation.
7. Remediation: supported changes, meaning of tested and verified, safe customer-code execution, exact state binding, concurrent edits, approval lifecycle, uncertain outcomes, reconciliation, and rollback.
8. Operations and abuse: resource isolation, malicious tenants, network restrictions, overload behavior, fairness, provider limits, connector compromise, platform incidents, recovery, and on-call ownership.
9. Data and economics: source and telemetry sensitivity, model-provider processing, credential custody, retention, deletion including backups, regional constraints, metering, quotas, and all-in cost limits.
10. Release evidence: representative customers and traffic, false-positive and missed-detection criteria, attack fixtures, recovery measurements, end-to-end demonstration, and pilot acceptance criteria.
11. Reference reconciliation: inspect the detailed reference, resolve conflicts explicitly, specify state machines and API contracts, and obtain confirmation of the completed definition.

## Round 1 — answered

### Q1 — First customer

Recommendation: optimize the pilot for a technically capable solo founder or very small team operating a revenue-generating Node/TypeScript SaaS, with control of its repository and deployment and the ability to review a PR. Businesses without a technical operator are outside the first pilot.

User answer: "this is more focused on teams that have tech teams but a non technical can also do it".

Decision: focus on businesses with technical teams. Nontechnical users must also be able to use the product. The original solo-founder-first recommendation was not accepted. Exact nontechnical duties, onboarding prerequisites, and authorization permissions remain unresolved.

### Q2 — Responsibility during an active attack

Recommendation: the customer owns incident response and production changes during the pilot, including when nobody is available to approve a fix. The product provides detection, evidence, alerts, and approved PRs; the pilot does not promise staffed round-the-clock response or automatic containment. Existing WAF enforcement is a customer capability, not proof that an attack is contained.

User answer: "yes". Recommendation accepted.

### Q3 — Meaning of independent authorization

Recommendation: one authorized organization owner may request an investigation and approve the resulting exact proposal using fresh second-factor authentication. Independence means enforcement outside the model, with a separate executor; it does not require two distinct human approvers in the pilot. Merge and production deployment remain separate.

User answer: "yes". Recommendation accepted.

### Q4 — Investigation-worker compromise

Recommendation: treat a fully compromised investigation worker as a required pilot threat scenario. It cannot mint approvals, retrieve integration credentials, or invoke provider write operations. Provider reads go through a server-authorized, scoped gateway. Detailed scope, revocation, data exposure, and implementation costs require follow-up decisions.

User answer: "yes". Recommendation accepted.

## Round 2 — answered

User answer to the round: "alright". Recorded as acceptance of the four recommendations, with that interpretation stated in the next response.

### Q5 — Primary buyer and reason to pay

Recommendation: prioritize an engineering lead or founder in a small software team without a dedicated security function. The primary job is to identify which security issues require action and get supported corrections ready for review. A pilot that adds alerts without reducing triage work fails its value test. Exact outcome measurements and team-size limits remain to be decided.

Status: accepted through the user's assent to Round 2.

### Q6 — Nontechnical approval authority

Recommendation: a nontechnical user with the organization Owner role may approve creation of an exact PR after fresh second-factor authentication and a plain-language explanation of effects, evidence, tests, and remaining uncertainty. Technical literacy is not an authorization role. Approval is not proof of technical correctness; GitHub review, merge, and deployment retain their separate controls.

Status: accepted through the user's assent to Round 2.

### Q7 — Value before complete instrumentation

Recommendation: allow a repository-only onboarding path that can produce an initial audit before SDK instrumentation, AWS permissions, or Cloudflare setup. Show runtime monitoring as not configured until event delivery and relevant heartbeat checks pass. Missing integrations are never implicitly counted as inspected coverage. Technical setup remains necessary for integrations that require code or provider permission changes.

Status: accepted through the user's assent to Round 2.

### Q8 — Customer automation triggered by PR creation

Scenario: a customer's automation deploys production or releases privileged secrets when a branch is pushed or a PR is opened. Opening an approved PR would then have consequences beyond the intended authorization boundary.

Recommendation: make repository automation safety an explicit prerequisite for enabling PR writes. When that prerequisite cannot be established under the supported policy, produce a reviewable patch without pushing a branch. The exact workflow checks, permitted configurations, customer attestations, and limits of the safety claim require follow-up definition.

Status: accepted through the user's assent to Round 2.

## Round 3 — answered

User answer to the round: "ok". Recorded as acceptance of the four recommendations, with that interpretation stated in the next response.

### Q9 — Supported first remediation

Recommendation: limit the initial PR adapter to security-related dependency patch and minor upgrades in supported npm repositories with reproducible lockfiles. Continue reporting other findings, but exclude major upgrades, bespoke source-code rewrites, cloud configuration writes, and WAF writes from this adapter. Exact npm and Node versions, repository layouts, transitive upgrades, and allowed lockfile changes remain to be specified after the scope decision.

Status: accepted through the user's assent to Round 3.

### Q10 — Readiness and verification evidence

Scenario: a proposed dependency update removes the scanner finding and the application builds, but the repository has no meaningful test suite. The available checks cannot establish that the change preserves application behavior.

Recommendation: require both an independent targeted rescan and a configured, relevant validation suite to pass at the proposed commit before offering a tested PR ready for review. Without adequate validation, provide an unverified patch and explain which checks ran. Record scanner verification and behavioral test results separately; never infer whole-application safety from either.

Status: accepted through the user's assent to Round 3.

### Q11 — Telemetry over capacity or quota

Scenario: attack traffic generates more security events than the customer's allowance or the platform's safe ingestion capacity, so some events cannot be accepted without exceeding a hard limit.

Recommendation: permit explicit rejection of new event batches at the ingestion boundary with appropriate retry responses. Never acknowledge events that have not been durably persisted. Use bounded client buffering and retries, preserve already accepted events under the agreed durability model, and expose telemetry degradation and known delivery-loss indicators. Exact admission controls, reserved capacity, fairness, and client overflow policies remain to be defined.

Status: accepted through the user's assent to Round 3.

### Q12 — Model budget during a critical incident

Scenario: a critical incident arrives after the customer's model-spend allowance is exhausted.

Recommendation: enforce the hard model-spend ceiling, including for critical incidents, with explicit delayed or unavailable investigation status. Deterministic detections, accepted-event processing, and alerts continue within their separately defined limits. Only an authorized customer action may increase the budget. Reservation accounting, in-flight work, provider overruns, and restart behavior require follow-up definition.

Status: accepted through the user's assent to Round 3.

## Round 4 — answered

User answer to the round: "alright". Recorded as acceptance of the four recommendations, with that interpretation stated in the next response.

### Q13 — Unrelated target-branch changes after approval

Scenario: the customer approves a tested dependency update, then a teammate pushes a documentation-only commit to the target branch before execution. The dependency files are unchanged, but the full base commit has changed.

Recommendation: bind the initial adapter to the full tested base commit. Any observed target-head change invalidates the proposal, requiring rebase or regeneration, validation, and fresh approval. Do not let the model decide that an intervening change is harmless. This can cause approval churn in active repositories. The precise atomicity guarantees available from the provider and changes after PR creation still need definition.

Status: accepted through the user's assent to Round 4.

### Q14 — Credential exposure without revocation evidence

Scenario: a proposed patch removes an exposed credential from current source, but there is no independent evidence that the credential has been revoked or rotated.

Recommendation: keep the credential exposure unresolved or explicitly mitigation-unverified until revocation or rotation is evidenced. Track source cleanup separately from credential invalidation. Customer attestations may be recorded as self-reported remediation but must not become independent verification. Do not use a recovered secret to probe a provider. Supported verification evidence and unavailable-verification behavior require follow-up definition.

Status: accepted through the user's assent to Round 4.

### Q15 — Healthy telemetry but no reachable responder

Scenario: application events arrive normally, but the organization has no configured responder, or all configured notification routes are known to have failed.

Recommendation: show response readiness as degraded, independently of telemetry coverage. Live monitoring setup requires a named customer responder and a verified notification destination; known subsequent failures remain visible without stopping event ingestion. Sending or provider acceptance does not count as customer acknowledgment. Notification channels, retry policy, acknowledgment, escalation, and unknown delivery outcomes remain to be specified.

Status: accepted through the user's assent to Round 4.

### Q16 — Proprietary source and event data sent to a model provider

Recommendation: require explicit organization opt-in to external model processing before enabling investigations that send bounded source excerpts or minimized security-event summaries. State that automated redaction cannot guarantee removal of every sensitive detail. Minimize and redact inputs; do not send full raw logs. An organization declining external processing retains deterministic checks, with agent investigation visibly disabled. Provider selection, retention settings, field-level boundaries, and what consent changes invalidate remain to be defined.

Status: accepted through the user's assent to Round 4.

## Round 5 — answered

User answer to the round: "ok i think we are actually ok with this. can you give me like an architectural overview of this. to see how it would look like". Recorded as acceptance of Q17 through Q20 and a request to move from interviewing to an architectural overview.

### Q17 — Isolation required for customer-code execution

Recommendation: require a disposable VM-class isolation boundary per job before executing customer dependency-install scripts or tests. Jobs receive no production or integration credentials, have bounded resources and lifetimes, and use explicitly controlled network access. Demonstrate the selected isolation controls before enabling the tested-PR path. If the reference hosting cannot satisfy this boundary, change runner hosting or withhold customer-code execution; do not weaken the boundary to preserve the two-VPS design. Actual provider support, sandbox technology, capacity, and cost remain to be researched and proven.

Status: accepted through the user's assent to Round 5.

### Q18 — Private-pilot disaster-recovery targets

Recommendation: set provisional private-pilot targets of at most fifteen minutes of customer-state and accepted-event loss after total control-plane loss, and restoration of core read and ingestion service within four hours. These are proposed recovery objectives, not measured guarantees. They require backup and recovery mechanisms capable of meeting the target and a successful clean-environment recovery drill before pilot launch. Customer disclosures must distinguish normal durable acceptance from disaster-recovery loss. Exact failure scenarios, recovery-point measurement, dependency outages, and execution recovery require follow-up definition.

Status: accepted through the user's assent to Round 5.

### Q19 — Approval and execution state after restoring a backup

Scenario: a restored database contains an approval as unused even though the executor consumed it and GitHub accepted the change after that backup was taken.

Recommendation: invalidate all approvals from before recovery and freeze provider writes after a restore. Reconcile existing provider state and durable execution identifiers before resuming writes, then require fresh approval for new work. Restored checkpoints or queue messages cannot revive an old authorization. Scope discovery, unknown outcomes, and safe resumption criteria still need specification.

Status: accepted through the user's assent to Round 5.

### Q20 — Total private-pilot operating-spend ceiling

Recommendation: adopt USD 250 per month as a provisional total platform operating-spend ceiling for the five-organization pilot, including hosting, models, storage, backups, and email. This is a proposed budget, not a vendor cost estimate. It excludes engineering labor and costs billed directly to customers by their own providers. Forecast and reserve committed costs, constrain variable work, and review actual provider pricing before launch. If the required isolation and recovery controls cannot fit, reduce supported scope or explicitly revise the budget before launch. Builder count, schedule, customer pricing, per-organization allocations, and overrun responsibility remain unresolved.

Status: accepted through the user's assent to Round 5.

## Accepted decisions

1. **D1 — Customer focus:** businesses with technical teams are the primary audience, and nontechnical people must also be able to use the product. No assumption yet that every onboarding task is possible without technical assistance.
2. **D2 — Response responsibility:** the customer owns incident response and production changes in the pilot, including outside working hours. The pilot promises detection, evidence, alerts, and approved PRs, without staffed round-the-clock response or automatic containment.
3. **D3 — Human authorization:** one authorized organization owner may both request an investigation and approve its exact proposal with fresh second-factor authentication. Independence is enforced outside the model by a separate executor. Two distinct human approvers are not mandatory. Merge and production deployment remain separately authorized.
4. **D4 — Compromised worker:** arbitrary code execution in the investigation worker must not enable approval issuance, retrieval of integration credentials, or provider writes. Provider reads require a server-authorized scoped gateway. Detailed data exposure, tenant scope, revocation, and service privileges remain to be defined.
5. **D5 — Buyer and value:** prioritize engineering leads or founders in small software teams without a dedicated security function. Reduce triage work and prepare supported corrections for review. Additional alerts alone do not establish pilot value; measurable acceptance criteria remain open.
6. **D6 — Nontechnical approvals:** an authorized nontechnical Owner may approve creation of an exact PR after fresh second-factor authentication and an explanation of its effects, evidence, tests, and uncertainty. Technical review, merge, and deployment remain separate.
7. **D7 — Partial onboarding:** repository-only onboarding is supported. Runtime monitoring stays not configured until delivery and heartbeat checks pass, and uninspected integrations remain visible. This does not remove the brief's requirement to build the scoped AWS connector before claiming deployed-resource coverage.
8. **D8 — Repository automation:** PR writes require supported repository automation-safety conditions. When those cannot be established, provide a patch without pushing a branch. Exact compatibility checks and the limits of this assurance remain unresolved.
9. **D9 — First write adapter:** security-related patch and minor dependency upgrades for supported npm repositories with reproducible lockfiles. Other findings remain reportable; major upgrades, bespoke source rewrites, cloud writes, and WAF writes are outside this adapter.
10. **D10 — Tested PR gate:** an independent targeted rescan and relevant configured validation suite must pass at the proposed commit. Without adequate validation, provide an unverified patch. Store scanner verification and behavioral validation separately, without implying whole-application safety.
11. **D11 — Ingestion limits:** explicit rejection of new batches is permitted at quota or safe-capacity limits. Never acknowledge unpersisted events. Buffering and retries are bounded; degradation and known losses are visible. The detection latency target applies after acceptance, with delivery delay measured separately.
12. **D12 — Model-spend limit:** critical severity does not override the model budget. Delay new model investigations at the limit, expose the reason, and continue deterministic monitoring and alerts within their separately defined limits. Budget increases require an authorized customer action.
13. **D13 — Base-commit freshness:** any observed target-head change, including documentation-only changes, invalidates the initial adapter's proposal and requires validation plus fresh approval. The model cannot exempt a change. Provider race guarantees and changes after PR creation remain open.
14. **D14 — Exposed credentials:** source cleanup does not verify credential invalidation. Record customer-attested rotation as self-reported and retain an explicit verification gap without suitable independent evidence. Never probe a provider using a recovered secret.
15. **D15 — Response readiness:** require a named customer responder and verified notification destination for monitoring setup. Show response readiness separately from telemetry health and mark known notification failures as degraded while continuing event ingestion. Delivery is distinct from acknowledgment.
16. **D16 — External model processing:** require explicit organization opt-in before source excerpts or minimized event summaries are sent to a hosted model. Minimize and redact inputs, without promising perfect redaction. Deterministic scanning and detection remain available when an organization declines agent processing.
17. **D17 — Customer-code isolation:** executing installation scripts or customer tests requires a disposable VM-class sandbox per job, with controlled networking, bounded resources, and no integration or production credentials. Change hosting or withhold execution if that boundary cannot be demonstrated.
18. **D18 — Recovery objectives:** provisional private-pilot objectives are at most fifteen minutes of lost customer state and accepted events after total control-plane loss, and core service restoration within four hours. Prove the objectives in a clean-environment recovery drill; these are not yet measured guarantees.
19. **D19 — Recovery authorization:** a database restore invalidates pre-recovery approvals and freezes provider writes until provider state and execution identities are reconciled. Replayed jobs and checkpoints cannot revive authorization.
20. **D20 — Operating budget:** provisional total platform operating-spend ceiling of USD 250 per month for the five-organization pilot, including hosting, models, storage, backups, and email. This excludes engineering labor and customer-paid provider charges. Scope or budget must change explicitly if the required controls do not fit; actual costs remain unverified.
21. **D21 — Authentication library:** use Auth.js instead of Better Auth, following the user's explicit instruction after the architectural overview. Fresh second-factor approval checks, organization authorization, and independent execution remain required. The particular step-up implementation has not been selected.
22. **D22 — Public HTTP host:** use TanStack Start for the dashboard and public API adapters. Keep domain services in framework-independent TypeScript packages and persistent work in separate coordinator, gateway, worker, executor, and runner processes. Fastify is not required for this foundation.
23. **D23 — Implementation workflow:** implement in parallel isolated worktrees, prioritize backend and infrastructure behavior over frontend design, validate meaningful failure cases, and record small coherent commits. The user requested Astra for difficult security work and Luna with xhigh effort for bounded tasks. This authorizes local implementation and verification, not cloud deployment or publication.

## Public API hosting recommendation

The user asked why Fastify was included and twice raised TanStack Start as a potential better fit. Fastify came from the original reference stack. The user then explicitly selected TanStack Start and authorized implementation. Public routes now adapt standard Request/Response objects to backend services; Auth.js Core supplies session handling through a custom adapter. Persistent workers and privileged services retain separate process boundaries. A separate HTTP server remains an option if future measured requirements justify it.

## Overview request

The overview request ended the interview. The subsequent instruction authorized implementation using the decisions above; it did not authorize deploying the platform. Current implemented behavior and remaining gates are tracked in `architecture.md` and `implementation-plan.md`.

## Completion rule

Resolve every material branch with an explicit decision, an explicitly accepted assumption, or a defined exclusion. Translate accepted choices into implementable behavior and measurable release checks. Mark the definition complete only after the user confirms the resulting shared understanding. Do not substitute recommendations for answers.

## Current accepted direction: controlled assessment demo

The user accepted this direction on 2026-10-24 as the immediate product and foundation scope. It updates what the current demonstration is meant to deliver; it does not erase the historical D1-D23 decisions or imply that their broader pilot capabilities have been implemented.

1. **Current product slice:** deliver a controlled assessment application with source and independent HTTP checks, persisted evidence-backed comparison reports, and a minimal usable Spanish dashboard. Assessments operate in observation mode against a fictional, operator-controlled store fixture.
2. **Fixed public demo scope:** operator-seed one fixed organization, application, public demo principal, and target. Public requests choose only the assessment mode and vulnerable/corrected revision; they cannot supply or change tenant, application, target, URL, or path. Customer business data remains protected by tenant authorization and Postgres row-level security; only the isolated fictional demo scope is public.
3. **Finite admission:** the backend enforces at most three unfinished jobs and 100 lifetime jobs for the demo scope. Each web process additionally allows at most 10 new idempotency keys per rolling minute and 30 well-formed assessment POSTs per 60-second window. Per-process request limits are not global quotas or measured throughput guarantees. The demo has no unlimited assessment endpoint.
4. **Narrow internal profile:** inspect only three fixed fixture files using deterministic TypeScript AST/literal and configuration checks plus one pinned offline lodash advisory, GHSA-35jh-r3h4-6jhm. The corrected fixture removes an unused lodash declaration. This is not general SAST, and it does not execute code, install packages, run customer tests, or attempt exploitation.
5. **Independent external profile:** allow one bounded GET to a fixed route on an operator-configured literal loopback or RFC1918 IPv4 HTTP origin. This check needs no source access and accepts no public-request URL. It does not authenticate, follow redirects, retry, run JavaScript, or exploit the target.
6. **Report semantics:** keep confirmed observations, indications, unknown coverage, severity, confidence, and exploitability distinct. Correlation between source and HTTP findings does not establish deployment equivalence, exploitation, or compromise. Vulnerable advisory matches and traffic anomalies are not proof of exploitation or attack. Partial or missing coverage is never presented as secure.
7. **Authorization modes:** incident severity never expands action permissions. Observation, exact approval, and bounded preauthorized automation are distinct modes. This demo only observes; approval, automatic response, and cross-provider recovery remain later release gates.
8. **Portable providers:** AWS is the primary deployment target, while core workflows remain behind replaceable adapters and open contracts. GitHub repository access, a model API, any particular OIDC provider, and paid external services are not mandatory. Auth.js supports generic HTTPS OIDC or optional GitHub sign-in; live OAuth remains unproven.
9. **AWS evidence:** the current Pulumi foundation describes two EC2 instances and private S3 storage. Its policy tests use mocks. No deployment, live AWS check, production certificate path, restore proof, or measured capacity/cost is claimed.
10. **Local demo lifecycle:** after `pnpm install --frozen-lockfile`, `pnpm demo:start` builds the relevant packages, starts Compose Postgres/Redis, applies the operator-only seed, and starts the built web/coordinator processes with an inline target. It records PIDs, ports, logs, and state in `.local/demo`; configurable web/coordinator ports are `GOTCHU_DEMO_WEB_PORT` and `GOTCHU_DEMO_COORDINATOR_PORT`. `pnpm demo:stop` stops only the recorded web/coordinator processes. `scripts/infra-local-down.sh` separately stops the data services while retaining volumes. The workflow requires Node 24, pnpm 11, and Docker.
11. **Deferred product requirements:** monitoring and alerting, general scanners, AWS customer-resource coverage, production identity and MFA, approved provider writes, containment, customer-code execution, production hosting, disaster recovery, and measured operations remain separate gates. Customer-code execution stays disabled until VM-class isolation is demonstrated.

The previous rounds remain the record of broader product intent and the reasons behind later release gates. They should not be read as claims that the controlled assessment demo already provides monitoring, AWS customer-resource coverage, approved remediation, or automatic response.
