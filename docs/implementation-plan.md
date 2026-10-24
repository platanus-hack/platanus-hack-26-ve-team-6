# Platform foundation implementation

The selected web framework is TanStack Start with TanStack Query. Auth.js remains the authentication library; its adapter, sessions, CSRF behavior, and fresh second-factor approval integration require explicit validation. The user authorized implementation, parallel worktrees, focused commits, Astra for harder tasks, and Luna with xhigh reasoning for general tasks.

## First integrated milestone

Deliver a runnable local control-plane foundation with validated signed event ingestion, tenant-isolated Postgres state, a transactional outbox, repeated-delivery-safe jobs, deterministic incident aggregation, a bounded LangGraph investigation, independent proposal and approval validation, and a minimal authenticated HTTP surface. Provide Compose and infrastructure definitions plus checks that actually boot and exercise the data services. Keep UI design minimal.

This milestone establishes infrastructure and security behavior. It does not claim deployed AWS coverage, live customer WAF ingestion, complete scanner hosting, verified GitHub production execution, proven disaster recovery, or a measured monthly infrastructure cost. Those capabilities stay disabled or explicitly unavailable until their gates pass.

## Work streams and ownership

- Parent: root workspace, shared contracts, TanStack Start and Auth.js integration, end-to-end integration, history, and release documentation.
- Astra backend worktree: `packages/backend`, `packages/database`, backend migrations and meaningful security/integration tests. Define durable event ingestion, tenant permissions, outbox claiming, and proposal/approval/execution invariants. Export an explicit backend interface for route and worker adapters.
- Luna orchestration worktree: `apps/worker`, `apps/executor`, `packages/agent`, and their tests. Implement an actual LangGraph graph, bounded read/model interfaces, typed outputs, deterministic rules, explicit unavailable states, and independent executor orchestration. Coordinate with the backend interface; no raw database or integration credentials in the agent.
- Luna infrastructure worktree: `infra/`, `scripts/infra-*`, deployment documentation, and CI. Provide isolated Compose data/services, a distinct scanner boundary, fail-closed VM execution gate, Pulumi TypeScript resources and validation, and safe local dependency checks. Do not deploy paid infrastructure or change host security settings.

## Shared conventions

Use Node 24, pnpm 11, ESM TypeScript, Zod runtime contracts, `@gotchu/` workspace packages, and Vitest. Build library packages before consuming their `dist` exports. Each stream adds dependencies only to its owned package manifests; the parent resolves and commits the final lockfile.

The public web API uses thin TanStack server routes. Domain logic lives in backend packages. Jobs carry durable IDs, not secrets or arbitrary executable commands. An authenticated server context establishes the organization; no `x-user-id`, client organization, or supplied graph thread ID is authorization.

The event contract starts with `eventBatchSchema` in `@gotchu/contracts`. The HTTP request authenticates integration ID, signed timestamp, and exact raw bytes; the backend derives the organization and checks the application. Scanners and customer-code execution remain separate from the control plane.

## Validation and commits

Create small commits around contracts, database isolation, ingestion/outbox, investigation, executor policy, web authentication, deployment definitions, and integration evidence. Do not squash unrelated work into one commit. Keep tests beside the behavior they establish. Report mocked unit checks separately from real Postgres/Redis/Compose tests.

Before handoff, run package builds, typechecks, unit tests, negative security fixtures, live Postgres/Redis integration checks, Compose validation, and a minimal production web build. Record failures honestly and keep unfinished external integrations visibly disabled.
