# Working on Gotchu

Build the backend and infrastructure first. The selected web framework is TanStack Start and the selected authentication library is Auth.js. Keep domain logic out of route files, persistent workers out of HTTP request lifetimes, provider writes inside the independent executor, and customer-code execution disabled until VM-class isolation is demonstrated.

Read `docs/definition-interview.md`, `docs/architecture.md`, and `docs/implementation-plan.md` before making architectural changes. A reference or proposed limit is not a measured production guarantee.

Use focused commits for coherent changes. Include meaningful tests for tenant isolation, event authentication and replay handling, durable outbox delivery, budgets, and exact approval semantics. Never substitute a mock passing test for a live infrastructure check without labeling the distinction.

Parallel agents work in isolated worktrees. Own the directories assigned by the parent; do not overwrite another stream's code. Commit your changes locally and report commit SHAs, checks, gaps, and integration contracts. Do not push or open PRs unless assigned. Do not delegate additional work without coordinating with the parent because the team has a bounded concurrency budget.

Use pnpm and the root TypeScript settings. Package names use `@gotchu/`. Runtime input contracts belong in `@gotchu/contracts` or explicitly exported domain packages. Do not commit secrets, generated build output, node_modules, Pulumi state, or local test credentials. Agents may update dependencies in their own package manifests; leave the shared lockfile for the parent to reconcile after integration.

During this foundation work, security-sensitive backend design and review use gpt-6-astra. Bounded implementation and infrastructure tasks may use gpt-6-luna with xhigh reasoning effort, following the user's model preference.
