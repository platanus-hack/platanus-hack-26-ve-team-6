# Commit history inventory

## Fixed baseline and continuation

The original ledger remains fixed at `8c03aca79c9d60aa750f72818611131f86d55bfe` and contains **332 commits**. Its rows are unchanged in [part 1](commit-history-001.md), [part 2](commit-history-002.md), and [part 3](commit-history-003.md). The first continuation through `7cbf3ed6cf977c55a17517f92c8d2ddecefa1816` adds **41 commits**, bringing the measured history to **373 commits**. This continuation adds every commit reachable after that endpoint through current integration HEAD `8b940a853d2c94af08447ce4ec69eadd437cb577`: **302 commits**, bringing the measured history to **675 commits**. Continuation parts use the root ancestry’s cherry-picked SHAs.

The 675 rows are split into these chronological files:

- [Commits 1–111](commit-history-001.md): `9b1624f052b9` through `952e3c17f21b`.
- [Commits 112–222](commit-history-002.md): `906fda570933` through `950eebb1221f`.
- [Commits 223–332](commit-history-003.md): `df2d71385cba` through `8c03aca79c9d`.
- [Commits 333–355](commit-history-004.md): `9a7d08bd8b19` through `e2fe67e69211`.
- [Commits 356–373](commit-history-005.md): `15518302316b` through `7cbf3ed6cf97`.
- [Commits 374–483](commit-history-006.md): `792e3d58df3e` through `0687e8b2841c`.
- [Commits 484–593](commit-history-007.md): `209ebc5b2bc0` through `050e3f9d7514`.
- [Commits 594–675](commit-history-008.md): `4c6f86f89be6` through `8b940a853d2c`.

Large changes and the recent milestone are summarized in [the outlier and continuation review](commit-history-outliers.md).

## Measurement rules

- Each commit is measured against its first parent. The root commit is compared with the empty Git tree. This captures merge resolution once while counting branch commits as their own commits; there are no merges through the fixed endpoint.
- Diffs use Git numstat with rename detection disabled. `Files` counts changed paths, so a rename is represented as a deleted path plus an added path.
- `Raw + / − / total` gives added lines, deleted lines, and their sum. Binary files have no line count in numstat; they still count as files and appear in `Binary files`. No binary changes occur through the fixed endpoint.
- `Authored + / − / total` uses the same line counts after excluding lockfiles, confirmed generated output, vendored data, and only the static fixture data listed below. Totals are additions plus deletions, not net growth. Repeated edits are counted in every commit where they occur.
- Excluded paths are narrowly scoped to files observed in the measured history:
  - **Lockfiles:** `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, and files ending in `.lock`.
  - **Generated output:** `apps/web/src/routeTree.gen.ts`; `docs/triage-evaluation.json`; `docs/triage-evaluation-holdout-repeat-v1.0.2.json`; and `docs/triage-evaluation.md`. The route tree header identifies TanStack Router generation; the JSON files store evaluation-run output, and the Markdown report is emitted by the report formatter.
  - **Vendored data:** `packages/customer-assessment/profiles/gitleaks.toml`, the upstream Gitleaks v8.28.0 default configuration (the adjacent license file remains authored); and `packages/customer-assessment/test/fixtures/schema/bom-1.5.schema.json`, the official CycloneDX 1.5 schema (its explanatory README remains authored).
  - **Fixture data:** `apps/demo-target/src/fixtures/**`; `apps/validator/test/fixtures/node-regression/package.json`; `apps/validator/test/fixtures/node-regression/src/feature.js`; and `packages/customer-assessment/test/fixtures/live-sca-project/**`, a static sample project containing a manifest, sample source, and lockfile variants. Lockfiles also match the general lockfile rule.
- Fixture and vendor boundaries were checked against changed paths in the measured range. The CycloneDX schema is upstream data; the Semgrep rules are original Gotchu rules and remain authored. Other code remains authored, including fixture READMEs, the demo target README and package manifest, server (`src/index.ts`), entrypoint (`src/main.ts`), tests and harnesses, and TypeScript configs.
- Reproduce the continuation measurements with [the measurement script](measure-commit-history.py): `python3 docs/measure-commit-history.py 7cbf3ed6cf977c55a17517f92c8d2ddecefa1816 8b940a853d2c94af08447ce4ec69eadd437cb577`. It reports per-commit first-parent numstat with rename detection disabled, totals, and strict thresholds.

## Measured totals

| Scope | Commits | Raw + / − / total | Authored + / − / total |
|---|---:|---:|---:|
| Original baseline through `8c03aca79c9d` | 332 | 51,778 / 3,044 / 54,822 | 45,782 / 2,845 / 48,627 |
| Continuation `8c03aca79c9d..e2fe67e69211` | 23 | 1,586 / 141 / 1,727 | 1,586 / 141 / 1,727 |
| Pre-merge continuation `e2fe67e69211..7cbf3ed6cf97` | 18 | 1,217 / 134 / 1,351 | 1,217 / 134 / 1,351 |
| Integration continuation `7cbf3ed6cf97..8b940a853d2c` | 302 | 43,749 / 2,158 / 45,907 | 24,824 / 2,145 / 26,969 |
| Combined through `8b940a853d2c` | 675 | 98,330 / 5,477 / 103,807 | 73,409 / 5,265 / 78,674 |

Thresholds are strict. Across the original baseline and continuations, **51** commits exceed 300 authored lines, **11** exceed 1,000 raw lines, and **5** exceed 1,000 authored lines. The new 302-commit continuation contributes **9**, **3**, and **0**, respectively. Its largest authored change is `751735ee5d7d` at **531 lines**; the largest raw change is the generated evaluation artifact `debadba43fbd` at **11,746 lines**. The largest authored change in the full inventory remains `bb7c955342bd` at 2,955 lines. See the [outlier review](commit-history-outliers.md).

## Navigating the pre-merge corrections

The focused code and evidence behind this continuation are grouped here for review:

- **Customer scope, local origin, and routes:** `839e885d976e` scopes the member panel to its workspace in [customer-dashboard.tsx](../apps/web/src/components/customer-dashboard.tsx); `2bba49a7e9fa` keeps the loopback runtime available without WebAuthn in [runtime.ts](../apps/web/src/server/runtime.ts); `b595e02f974e` matches environment routes to client paths in [context-api.ts](../apps/web/src/server/context-api.ts).
- **Probe settings and bounded triage context:** `baa3474c57fe` maps probe settings to the API DTO in [backend triage](../packages/backend/src/triage.ts); `4307ea9d261b`, `b649e6be9ca2`, and `5eaf5ff464f6` bound customer identifiers and structured/deployment context in [triage inputs](../packages/triage/src/inputs.ts) and [coordinator triage](../apps/coordinator/src/triage.ts).
- **Git containment and workflow guards:** `d3dd480b281d`, `15f330fefe42`, `0176bc8175cc`, `cbf352ad54c2`, and `7cbf3ed6cf97` harden local publish containment and workflow/branch checks in [git-adapters](../packages/git-adapters/src/index.ts), with regressions in [adapter tests](../packages/git-adapters/test/adapters.test.ts).
- **Validator/runner provenance and cleanup:** `a488fff4243d`, `e797c16d00cc`, and `336e761186bb` cover staged-input resolution, uncertain cleanup quarantine, and referenced setup files in [validator](../apps/validator/src/validator.ts); `9b92710e3d52` binds dependency evidence to host verification in [firecracker.ts](../packages/runner/src/firecracker.ts) and [vm-output.ts](../packages/runner/src/vm-output.ts).
- **Runtime image packaging:** `464f19dbc42c` adds the triage package to the runtime images and smoke checks in [Dockerfile](../Dockerfile) and [infra-check.mjs](../scripts/infra-check.mjs).

The corresponding review, package, local-database, and browser evidence is in [the validation record](validation.md#pre-merge-corrections-and-focused-verification--2026-10-24).

## Future commit discipline

Keep each focused commit near 300 authored changed lines or fewer, consistent with `AGENTS.md`. Split larger work by layer where that keeps each step coherent, and explain exceptional commits in their message body. The measured earlier milestone contains 20 commits with a maximum of 288 raw and 288 authored changed lines; this is a measured result for that range, not a claim that the full history stayed below the target.

## Earlier integration plan at `7cbf3ed6cf97`

At the prior fixed endpoint, the exact original-main range `5d5c35f05f84..7cbf3ed6cf97` contained 234 commits. The recorded plan was a normal fast-forward of `main`, preserving those commit SHAs, after hosted CI passed. GitHub [limits rebase-and-merge to 100 commits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits#rebase-limits), so it could not apply to that full range. At that endpoint, no rewrite, force-push, squash, or merge had occurred.

The current fixed measurement endpoint is integration HEAD `8b940a853d2c94af08447ce4ec69eadd437cb577`. The post-`7cbf3ed` documentation commits are included in this continuation. The measurement script and documentation commits that add parts 6–8 and revise this index and the outlier review follow the current endpoint and are intentionally excluded from the ledger.
