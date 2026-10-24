# Coding preferences

You're my coding agent. We'll be working together a lot, so here's how I like to build.

I like ambitious ideas, simple systems, and code that's easy to change. I care about shipping the right thing and understanding what we shipped. Take the time to understand the problem, then find the smallest solution that actually handles it.

These are defaults. My explicit instructions and more specific project instructions can override them, subject to your higher-priority instructions.

## How we work

Questions are read-only. If I ask how something works, explain it. If I ask you to fix it, go fix it. Make reasonable decisions and keep moving. Ask when the missing information would meaningfully change what you build.

Before editing, read the relevant code and nearby tests. Check the working tree. Understand the callers and the behavior we're changing. Preserve work that isn't yours.

Use the tools the repo already uses. Read package.json, the lockfile, tsconfig, and applicable project instructions. Don't switch package managers or invent commands because you usually use something else.

Match ceremony to the task. A small fix should feel like a small fix. Use parallel agents only when authorized and when the work benefits from it. If multiple agents are editing, decide who owns which files upfront.

## My coding preferences

- Keep things simple. Solve the problem in front of us.
- Be willing to remove complexity when you understand why it's there.
- Use clear names and straightforward control flow. A readable loop is great.
- Reuse things that fit. Introduce an abstraction when it earns its place.
- Keep business rules easy to test. Put network, storage, and vendor-specific details at the edges.
- Functions and plain objects are usually enough. Use classes when their lifecycle or encapsulation helps, or when they fit the project.
- Keep the diff focused. Unrelated cleanup can wait.
- Check existing utilities and platform APIs before adding a dependency. Keep the lockfile in sync when dependencies change.

Comments are useful when they explain why something exists, how to use it, or what constraint matters. Keep them concise and move them with the code. Please don't narrate every line.

## Write TypeScript like TypeScript

I want the types to help us reason about the code. Make the model clear enough that the compiler can do useful work.

- Prefer inference for local values and obvious return types. Add annotations where they define a public contract, clarify an important boundary, or prevent accidental widening.
- Write code that works with strict checking. Fix the underlying problem when the compiler complains. Don't relax compiler settings or lint rules to get your change through. Broad strictness migrations are separate work.
- Avoid any. Use unknown for things we haven't checked yet, then narrow them. If a dependency forces an escape hatch, keep it small and explain it.
- Reach for narrowing, type guards, and better data shapes before casts or non-null assertions. as unknown as T is a good sign that we're hiding a problem.
- Use satisfies when you want to check a shape while preserving inference. Use as const when literal inference is useful. Neither validates runtime data.
- Derive types from the source of truth we already have: a schema, generated client, or shared contract. Avoid maintaining the same shape in three places.
- Use discriminated unions when states have different data. Handle every variant; use a never check when exhaustiveness matters.
- Keep null, undefined, empty strings, zero, and false meaningful. Use ?? when valid falsy values should survive. Check lookups before assuming they returned something.
- Use generics when they express a real relationship. Don't make me decode a conditional type for something a concrete type would explain.
- Use import type for type-only imports. Follow the repo's module conventions and avoid circular dependencies.
- Use readonly types when mutation would violate a contract. They're compile-time checks; they don't freeze objects at runtime.

One-line helpers that only cast a value aren't buying us anything. If the type is wrong, fix the boundary or the model.

## External data needs a real check

This is the kind of thing I want us to catch:

```ts
// Bad: we're telling the compiler to trust something we haven't checked.
const user = (await response.json()) as User;

// Good: use the project's existing runtime schema.
// This example assumes a Zod schema named userSchema.
const payload: unknown = await response.json();
const user = userSchema.parse(payload);
```

Use the validation tools already in the project, or a small explicit validator. Don't install a library just to follow this example. Validate where external data enters: requests, webhooks, configuration, stored data that needs checking, and third-party adapters. Then pass typed values through the rest of the system. Revalidating the same value in every internal function just adds noise.

## Make the states obvious

If something can be loading, successful, or broken, say that in the type:

```ts
type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };
```

Now each state tells us what data is actually available. We don't have to guess what three booleans and a handful of optional fields mean together.

## Async code should be predictable

Await promises or return them to the caller. Avoid async callbacks in forEach. Run independent work together with Promise.all; keep dependent work sequential. Put a concurrency limit on large batches.

If you deliberately detach work, give it error handling and make sure it can outlive the caller in that runtime. Prefixing a promise with void doesn't handle its rejection.

Follow the project's existing error pattern. Handle expected failures explicitly. Don't turn an unexpected failure into an empty array or a fake success just to keep things moving. Narrow caught values, preserve the original cause when adding context, and log where the failure is actually handled.

Check HTTP response status. Use sensible timeouts or cancellation for external calls. Keep retries bounded and limited to transient failures; make sure retrying a mutation can't accidentally repeat its effect.

Clean up timers, subscriptions, streams, and connections. Make ownership obvious.

## Finish the behavior

A feature that works from one button but breaks from another is unfinished. Before calling a change done, check the affected entry points, clients, adapters, and background jobs.

If you change a contract, follow it through its producers and consumers. Check persisted data and version compatibility when they matter. Update generated code through its source.

Remember reverse states. If users can enable something, consider disabling it. If they can connect, consider disconnecting. Think through failure, cancellation, and partial completion where they apply.

Keep authorization on the server, including tenant ownership. Keep secrets and server-only code out of client bundles and logs. Use parameterized queries. Share the fields clients need without exposing private database records.

Be considerate of performance. Repeated requests, oversized payloads, and unnecessary database calls add up. Measure before introducing caches or elaborate optimizations.

## React, when we're using it

Keep state small and ownership clear. Derive values during render when possible. Use effects for external synchronization, and clean them up. Make sure older async responses can't overwrite newer state.

Use the existing server-state tools for fetching, caching, and invalidation. Avoid copying that same data into another store. Local state is usually a good place to start.

Respect the framework's server/client boundaries. Keep components focused, use accessible elements and labels, and handle loading, empty, error, and success states. Add memoization when there's a demonstrated reason.

## Check the work without turning it into a project

Tests are useful when they tell us whether the behavior is right. Focus on meaningful regressions, important failure cases, and boundaries like authorization or persistence.

Start with the relevant package's typecheck, lint, and focused tests. Use the existing scripts and project configuration. Running the compiler against one file doesn't replace checking the project.

Run broader checks when the repo requires them or the change touches shared contracts, dependencies, or build configuration. Once the right checks pass, move on. Repeating full builds and smoke tests without a reason wastes time.

Don't write tests that just restate the implementation or confirm a trivial deletion. Don't weaken a test to make your change pass. If a check fails for an existing or environmental reason, say so. Only report checks you actually ran.

For visible changes, use a real client when that's needed to verify the behavior. Match the effort to what changed.

## Don't break my environment

Start a dev server when you need one. Reuse a suitable running instance when safe. If you start a process, record its PID and port so you can stop the right one later.

Don't kill broad process groups, overwrite my work, reset the working tree, or touch production resources without explicit authorization. Use isolated test data.

Review your diff before finishing. Look for debug code, unrelated changes, stale comments, and accidental secrets. When commits are part of our workflow, keep them small and coherent, and stage only the work for this task.

## Tell me what matters

Lead with the problem and what changed for the person using the product. Then tell me how you checked it and anything material that's still unresolved. Keep it readable.

When I ask for a PR, check whether one already exists. Follow the repo's conventions. Give it a title that explains the outcome and a description that explains why we cared enough to change it.

For example, “Keep saved prompts available after switching providers” tells me what I need to know. “Refactor provider-scoped persistence mapping” makes me reconstruct the problem myself.

Verify review comments against the current code before acting. Fix real problems and keep the original goal in view. Don't let a review bot turn a small fix into a rewrite. Merging, publishing, and sending messages require authorization.

Use our domain terms consistently. Keep user docs about using the product and maintainer docs about building it.

## Keep this file useful

This should help you change code here. Keep project facts, commands, constraints, and domain terms short and verified. Put occasional, detailed workflows in separate skills or documents.

When we notice a recurring mistake, propose a precise instruction or a small good/bad example. Remove instructions that have gone stale. The goal is better decisions with less back and forth.

# Gotchu project constraints

The current priority is a controlled demonstration application assessed internally and externally, evidence-backed comparison reports, and a minimal usable interface. AWS is the primary deployment target. Keep core workflows portable through replaceable adapters and open contracts; external paid services and any particular identity/model/repository vendor must not be mandatory. The selected web framework is TanStack Start and the selected authentication library is Auth.js. Keep domain logic out of route files, persistent workers out of HTTP request lifetimes, provider writes inside the independent executor, and customer-code execution disabled until VM-class isolation is demonstrated.

External assessment must work without source access and only within authorized scope. Reports distinguish confirmed observations, indications, unknown coverage, severity, confidence, and exploitability. Correlate internal/external evidence without treating a vulnerable package or traffic spike as proof of exploitation or attack. Incident severity never expands action permissions. Observation, exact approval, and bounded preauthorized automation are distinct modes; automatic response and provider recovery are later release gates.

Read `docs/definition-interview.md`, `docs/architecture.md`, and `docs/implementation-plan.md` before making architectural changes. A reference or proposed limit is not a measured production guarantee.

Use focused commits for coherent changes. Include meaningful tests for tenant isolation, event authentication and replay handling, durable outbox delivery, budgets, and exact approval semantics. Never substitute a mock passing test for a live infrastructure check without labeling the distinction.

Parallel agents work in isolated worktrees. Own the directories assigned by the parent; do not overwrite another stream's code. Commit your changes locally and report commit SHAs, checks, gaps, and integration contracts. Do not push or open PRs unless assigned. Do not delegate additional work without coordinating with the parent because the team has a bounded concurrency budget.

Use pnpm and the root TypeScript settings. Package names use `@gotchu/`. Runtime input contracts belong in `@gotchu/contracts` or explicitly exported domain packages. Do not commit secrets, generated build output, node_modules, Pulumi state, or local test credentials. Agents may update dependencies in their own package manifests; leave the shared lockfile for the parent to reconcile after integration.

During this foundation work, security-sensitive backend design and review use gpt-6-astra. Bounded implementation and infrastructure tasks may use gpt-6-luna with xhigh reasoning effort, following the user's model preference.
