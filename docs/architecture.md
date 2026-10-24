# Gotchu controlled assessment architecture

The current product slice is a controlled assessment application with a minimal Spanish dashboard. It performs bounded checks against a fixed fictional store in two independent ways: a source/configuration profile and a live HTTP profile. It compares and persists their evidence as scoped reports. These are real executions against controlled fixtures, not prefilled results.

This is a narrow demonstration, not general SAST, an exploitation service, or a production security product. It does not require a model API, GitHub repository access, or an external paid service.

## Assessment flow

```mermaid
flowchart LR
  browser[Spanish dashboard]
  web[TanStack Start web process]
  demo[Fixed public demo API]
  backend[@gotchu/backend]
  pg[(Postgres<br/>tenant-scoped rows and durable reports)]
  redis[BullMQ on Redis]
  coordinator[@gotchu/coordinator<br/>separate durable worker]
  runner[@gotchu/assessment<br/>one active runner slot]
  source[Controlled fixture repository<br/>three allowlisted files]
  target[Private HTTP target<br/>literal IPv4 origin]
  reports[Evidence and comparison report]
  auth[Auth.js Core<br/>member sign-in, optional]

  browser -->|assessment request| web
  web --> demo --> backend
  backend -->|job and outbox transaction| pg
  pg -->|durable job| coordinator
  coordinator --> redis --> coordinator
  coordinator --> runner
  runner -->|bounded source reads| source
  runner -->|one source-independent GET| target
  runner -->|internal/external comparison| reports
  reports -->|persist in fixed demo scope| pg
  pg -->|scoped report data| backend
  backend --> demo --> web -->|history, evidence, coverage| browser
  browser -.-> auth
```

The assessment job is processed outside the web request. The coordinator owns a single active assessment runner slot per process and applies a 60-second overall timeout. Postgres holds the durable job, outbox, and report; Redis is a delivery queue. Repeated delivery is handled through the durable job state.

## Fixed public demo boundary

An operator-only seed creates one dedicated organization, application, public demo principal, and target key. The public API injects this fixed scope and can request only an assessment mode and one of the two fixture revisions. It accepts no caller-selected tenant, application, target, URL, or path. Runtime API and coordinator roles can read the target configuration but cannot change it. The operator-only seed validates existing state and refuses conflicting configuration rather than overwriting it.

Core customer data stays behind membership checks and Postgres row-level security. Public demo operations use only the reserved seeded scope and its fictional reports. The demo principal is not a customer login and is denied general business-data operations.

Capacity is bounded at two layers:

- The backend transaction allows at most three unfinished assessment jobs and 100 total assessment jobs for this demo scope. The lifetime cap requires deliberate operator cleanup in a disposable demo environment.
- Each web process allows at most 10 new idempotency keys in a rolling minute and 30 well-formed assessment POSTs in a 60-second window. These in-memory HTTP limits are per process; they are not global quotas or throughput guarantees.

Exact idempotent retries do not create additional jobs. These limits make the public demo finite; there is no unlimited assessment endpoint.

## Assessment profiles and report semantics

### Internal source/configuration profile

The profile reads only store.ts, settings.json, and package.json from a selected revision in the controlled fixture repository. Each file is capped at 16 KiB and each read has a two-second deadline. It uses TypeScript AST inspection for one exported literal, supported configuration parsing for the response-header settings, and an exact direct lodash version declaration check against one pinned offline record: GHSA-35jh-r3h4-6jhm / CVE-2021-23337.

The vulnerable fixture enables the audit-email literal, omits Content-Security-Policy, and declares lodash 4.17.20. The corrected fixture disables the literal, adds a policy, and removes the unused lodash declaration. Removing that declaration does not establish a safe replacement version or prove anything about installed/transitive packages. The advisory has no run-time freshness check.

This deterministic profile is not whole-program analysis or general SAST. It does not inspect a customer repository, lockfile, installed dependencies, reachability, or other advisories. It does not execute source, install packages, run scripts or tests, or attempt an exploit.

### Independent external HTTP profile

The external profile does not read source or package data. It makes one GET to the fixed vulnerable or corrected route at an operator-configured HTTP origin spelled as a literal loopback or RFC1918 IPv4 address. The origin cannot be supplied by a public request. The profile has a maximum two-second deadline, 2 KiB body cap, 8 KiB header cap, and retains at most 512 bytes of selected headers. It sends no credentials, refuses redirects, and does not retry.

It observes only a complete catalog response, Content-Security-Policy presence, and an X-Powered-By banner. It does not test authentication, other routes, JavaScript behavior, policy effectiveness, TLS, injection, exploitation, or cloud resources. A banner is an indication, not verified inventory.

### Correlation and evidence

Reports persist provenance, checksums, bounded evidence excerpts, limitations, coverage, findings, and comparisons. Findings keep severity, confidence, and exploitability as separate fields. The report distinguishes matching internal and external observations from internal-only, external-only, and unverified comparisons.

A package declaration matching an advisory is not proof that the package is installed, reachable, exploited, or responsible for an incident. A high advisory severity does not grant authority. Missing, partial, unsupported, or failed coverage remains visible as unknown; absence of a finding is not a secure result. Correlation does not prove that the inspected source is what the HTTP service deployed.

The public demo is observation-only and reports no performed actions. Incident severity never expands permissions. Exact approval and bounded preauthorized automation are separate modes; response automation and provider recovery remain later release gates.

## Web, identity, and tenant data

The web layer uses TanStack Start. Demo routes call a fixed-scope server adapter; domain rules live in framework-independent contracts and backend packages. Auth.js Core supports a generic HTTPS OIDC issuer or optional GitHub OAuth sign-in for member flows. No live OAuth integration has been demonstrated, and GitHub sign-in does not provide repository access. No identity vendor is mandatory for the controlled demo.

Tenant-owned business tables use Postgres row-level security and runtime roles. The public demo is intentionally different: its reserved identity may read and create only controlled assessment jobs and read reports from the seeded demo application. It cannot use general customer API operations or choose another scope.

## Local runtime and AWS direction

After the frozen pnpm install, scripts/controlled-demo.mjs builds relevant packages, starts Compose Postgres and Redis, applies the operator-only seed, and runs the built web and coordinator processes with an inline HTTP target. Defaults bind web to loopback port 3000, coordinator to loopback port 3003, and the target to loopback port 4100. Web and coordinator port overrides are GOTCHU_DEMO_WEB_PORT and GOTCHU_DEMO_COORDINATOR_PORT. The script records its PIDs, ports, logs, and state under .local/demo. Its stop command stops only the recorded web/coordinator processes. scripts/infra-local-down.sh separately stops the data services and retains their volumes.

Node 24, pnpm 11, and Docker are required for this local workflow. Local runs and mock tests do not establish cloud behavior.

AWS is the primary deployment target. Pulumi describes a control EC2 instance, a private EC2 instance reserved for the future scanner boundary, private S3 artifact storage, network policy, and role-scoped storage access. The controlled assessment currently runs inside the trusted coordinator against bundled fixtures; the private EC2 instance is not a configured scanner runtime or a disposable VM sandbox. The resource-policy tests use Pulumi mocks; no AWS deployment or live AWS check has been performed. Deployment, TLS, restore, capacity, and cost evidence remain open.

The domain contracts and storage/runtime adapters keep the core flow portable. AWS is the first deployment target, not a required provider dependency. GitHub, hosted models, any particular OIDC provider, and paid external services remain optional integrations.

## Later release gates

Monitoring integrations and alerts, general scanners, customer-code execution, production identity verification and MFA, exact approval, provider writes, bounded automatic response, cross-provider recovery, public TLS, deployed cloud services, restore evidence, and measured capacity/cost are outside this demonstration. Customer-code execution remains disabled until disposable VM-class isolation is demonstrated. The older event and investigation foundation is separate from this assessment flow; model requests remain unavailable without an explicitly configured provider.

See [implementation status and release gates](implementation-plan.md), the [architecture overview](architecture-overview.html), and the [current accepted demo direction in the definition interview](definition-interview.md#current-accepted-direction-controlled-assessment-demo).
