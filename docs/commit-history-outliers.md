# Large-change review and recent milestone

## Threshold summary

- `51` commits exceed 300 authored changed lines. Every one is listed below and marked `auth>300` in the chronological inventory.
- `11` commits exceed 1,000 raw changed lines.
- `5` commits exceed 1,000 authored changed lines.
- `0` binary files changed in the measured history.
- The largest authored change is 2,955 lines in `bb7c955342bd` (`feat(monitoring): add bounded read adapters`).

The fixture-path correction restores 186 authored lines across two otherwise sub-threshold commits: 171 in `99dbfa939c9b` (demo target implementation) and 15 in `bda7955dc8d1` (validator harness). The pre-merge continuation adds one commit above the 300-authored-line threshold. The latest 302-commit continuation adds nine more commits above that threshold, three raw outliers, and no authored outlier above 1,000 lines.

## Raw outliers with excluded-file contributions

These commits exceed 1,000 raw lines and include large lockfile, generated, or vendored-data deltas. The authored column applies the precise path exclusions defined in [the index](commit-history.md). Contributions below are read directly from each commit’s first-parent numstat. No >1,000-raw commit is driven by the static npm fixture project.

| Commit | Subject | Raw + / − / total | Authored + / − / total | Excluded contribution |
|---|---|---:|---:|---|
| `9e4bf68966d0` | build: lock workspace dependencies and allow esbuild for pnpm 11 | 1,063 / 2 / 1,065 | 2 / 2 / 4 | `pnpm-lock.yaml` +1,061; workspace manifest +2/−2 remains authored |
| `8dae20edc35f` | feat(api): connect authenticated routes to durable backend services | 2,028 / 46 / 2,074 | 251 / 3 / 254 | `pnpm-lock.yaml` +1,732/−40; generated `apps/web/src/routeTree.gen.ts` +45/−3 |
| `082914a457fa` | feat(coordinator): deliver durable jobs and fence investigation completion | 2,707 / 29 / 2,736 | 414 / 2 / 416 | `pnpm-lock.yaml` +2,293/−27 |
| `debadba43fbd` | test(eval): store generated triage evaluation results | 11,746 / 0 / 11,746 | 0 / 0 / 0 | Generated evaluation JSON artifacts: `docs/triage-evaluation.json` +11,513 and `docs/triage-evaluation-holdout-repeat-v1.0.2.json` +233 |
| `1f4e4af63430` | build(scanner): vendor pinned SAST and secret rule packs | 3,323 / 12 / 3,335 | 154 / 1 / 155 | Vendored upstream `profiles/gitleaks.toml` +3,169/−11; original Semgrep rules and license/docs remain authored |
| `7513a2f39749` | test(assessment): vendor CycloneDX 1.5 JSON schema | 3,800 / 0 / 3,800 | 1 / 0 / 1 | Vendored schema +3,799; authored explanatory README +1 |

The `9e4bf...`, `8dae20...`, `debadba...`, `1f4e4a...`, and `7513a2...` commits fall below 300 authored lines (4, 254, 0, 155, and 1). `082914...` has 416 authored lines, so it remains a large authored change even though the lockfile accounts for most raw churn. The other five raw outliers are authored changes above 1,000 lines and appear in the table below.

## All commits above 300 authored lines

`Raw` and `Authored` columns each show additions / deletions / total changed lines. `auth>1k` marks the five authored changes above 1,000 lines.

| Commit | Subject | Files | Raw + / − / total | Authored + / − / total | Flags |
|---|---|---:|---:|---:|---|
| `9b1624f052b9` | docs: record architecture decisions and parallel implementation plan | 6 | 495 / 0 / 495 | 495 / 0 / 495 | — |
| `605bf47898e1` | feat(web): add minimal TanStack Start and verified Auth.js session adapter | 14 | 447 / 0 / 447 | 343 / 0 / 343 | — |
| `3fd4746e4762` | feat(database): enforce tenant isolation and restricted runtime roles | 7 | 514 / 0 / 514 | 514 / 0 / 514 | — |
| `dd61c142edc5` | feat(backend): authenticate events and deliver durable tenant jobs | 16 | 475 / 29 / 504 | 475 / 29 / 504 | — |
| `dc120030597a` | feat(backend): bind approvals to exact independently verified actions | 8 | 396 / 2 / 398 | 396 / 2 / 398 | — |
| `75642ca725a1` | feat(gateway): enforce scoped runs and durable read authorization | 14 | 602 / 0 / 602 | 602 / 0 / 602 | — |
| `a896bb8fbfd3` | test(gateway): verify HTTP worker boundaries against Postgres | 5 | 538 / 0 / 538 | 538 / 0 / 538 | — |
| `45c1b6d306d0` | feat(agent): add scoped bounded LangGraph investigations | 9 | 1,463 / 0 / 1,463 | 1,463 / 0 / 1,463 | raw>1k, auth>1k |
| `fcd795aa40cf` | feat(worker): add capability-scoped investigation HTTP adapter | 11 | 826 / 0 / 826 | 826 / 0 / 826 | — |
| `0b69aa6c9a6d` | feat(executor): add independent claim and reconciliation orchestration | 6 | 864 / 0 / 864 | 864 / 0 / 864 | — |
| `cf1e65884116` | feat(executor): connect durable backend ledger and verify Postgres integration | 8 | 453 / 13 / 466 | 453 / 13 / 466 | — |
| `9176f502acac` | infra: add isolated local data services and checks | 10 | 745 / 0 / 745 | 745 / 0 / 745 | — |
| `4856efd25a60` | infra: provision DigitalOcean baseline with policy mocks | 10 | 355 / 0 / 355 | 355 / 0 / 355 | — |
| `082914a457fa` | feat(coordinator): deliver durable jobs and fence investigation completion | 11 | 2,707 / 29 / 2,736 | 414 / 2 / 416 | raw>1k |
| `1029876bbe1f` | test(integration): prove signed delivery recovery and atomic investigation results | 6 | 319 / 13 / 332 | 319 / 13 / 332 | — |
| `6fddfc656c8d` | docs: align architecture with implemented foundation | 4 | 407 / 181 / 588 | 407 / 181 / 588 | — |
| `afaebd21305c` | feat(infra): run web and coordinator in Compose | 9 | 431 / 101 / 532 | 431 / 101 / 532 | — |
| `67c4075c7b11` | feat(backend): persist scoped controlled assessment requests and reports | 11 | 580 / 6 / 586 | 580 / 6 / 586 | — |
| `ad6f62882669` | feat(assessment): compare bounded source and live HTTP evidence | 17 | 1,542 / 0 / 1,542 | 1,542 / 0 / 1,542 | raw>1k, auth>1k |
| `819f0ba51ebe` | feat(infra): replace DigitalOcean baseline with AWS pilot foundation | 9 | 605 / 258 / 863 | 605 / 258 / 863 | — |
| `93e3fd56cf73` | feat(dashboard): run assessments and inspect persisted evidence | 7 | 415 / 14 / 429 | 361 / 12 / 373 | — |
| `ec69dbca811c` | test: cover controlled assessments over the live pipeline | 1 | 395 / 0 / 395 | 395 / 0 / 395 | — |
| `810c885c2ce0` | docs: describe controlled assessment demo | 5 | 244 / 276 / 520 | 244 / 276 / 520 | — |
| `fd2c89420eb6` | Add authenticated customer assessments with fenced report completion | 5 | 675 / 6 / 681 | 675 / 6 / 681 | — |
| `c16e677a59cb` | Assess customer source and public HTTPS with bounded real scanners | 17 | 660 / 0 / 660 | 660 / 0 / 660 | — |
| `d56a4fc2414e` | feat(web): add authenticated customer workspace dashboard | 5 | 1,249 / 3 / 1,252 | 1,249 / 3 / 1,252 | raw>1k, auth>1k |
| `bc25705bad3f` | fix(scanner): retain admission through cleanup and coalesce readiness | 13 | 302 / 38 / 340 | 302 / 38 / 340 | — |
| `b757a6fb9a88` | test: exercise customer applications through live service processes | 1 | 437 / 0 / 437 | 437 / 0 / 437 | — |
| `cf3d2959c2c3` | Add local customer app development starter | 2 | 680 / 0 / 680 | 680 / 0 / 680 | — |
| `d0f22fe8223d` | docs: document customer assessment application | 4 | 208 / 213 / 421 | 208 / 213 / 421 | — |
| `906fda570933` | feat(telemetry): onboard scoped signed application events with key rotation | 13 | 310 / 8 / 318 | 310 / 8 / 318 | — |
| `3fdeacff7a1e` | Expose durable monitoring alerts and fail-closed operation plans | 4 | 568 / 5 / 573 | 568 / 5 / 573 | — |
| `82b5f9a73ded` | feat(assessment): add bounded public surface profile | 6 | 537 / 19 / 556 | 537 / 19 / 556 | — |
| `6db562d216df` | feat(monitoring): project signed runtime signals and assessment alerts durably | 7 | 327 / 0 / 327 | 327 / 0 / 327 | — |
| `bb7c955342bd` | feat(monitoring): add bounded read adapters | 19 | 2,955 / 0 / 2,955 | 2,955 / 0 / 2,955 | raw>1k, auth>1k |
| `c73fdad943a9` | feat(web): add customer vigilance and operations panel | 7 | 921 / 25 / 946 | 921 / 25 / 946 | — |
| `447d17ab185b` | feat(scenarios): add evidence-bound correction recipes | 10 | 1,138 / 0 / 1,138 | 1,138 / 0 / 1,138 | raw>1k, auth>1k |
| `371ad96e00df` | feat(web): prepare evidence-bound report corrections | 6 | 398 / 10 / 408 | 398 / 10 / 408 | — |
| `5d5c35f05f84` | docs: plan evidence-based triage and verified defensive actions | 3 | 429 / 0 / 429 | 429 / 0 / 429 | — |
| `755aba3ef069` | feat(triage): measure precision, recall and abstention per scenario | 3 | 316 / 0 / 316 | 316 / 0 / 316 | — |
| `748843c0c235` | test(triage): rebuild independent tuning and holdout corpus | 4 | 646 / 82 / 728 | 646 / 82 / 728 | — |
| `e797c16d00cc` | fix(validator): quarantine on first uncertain cleanup | 3 | 314 / 9 / 323 | 314 / 9 / 323 | — |
| `956cd0e396e5` | feat(git-adapters): verify candidate trees and workflows | 2 | 285 / 33 / 318 | 285 / 33 / 318 | — |
| `0c377c118e60` | feat(backend): add workspace notification outbox service | 2 | 301 / 2 / 303 | 301 / 2 / 303 | — |
| `38e74ef88c43` | feat(coordinator): send signed webhooks and SMTP alerts | 1 | 358 / 0 / 358 | 358 / 0 / 358 | — |
| `edaeaee898de` | test(coordinator): verify alert delivery against live services | 1 | 354 / 0 / 354 | 354 / 0 / 354 | — |
| `209ebc5b2bc0` | feat(backend): prepare validated dependency candidates | 3 | 289 / 19 / 308 | 289 / 19 / 308 | — |
| `751735ee5d7d` | feat(assessment): parse bounded npm pnpm and yarn lockfiles | 3 | 508 / 23 / 531 | 508 / 23 / 531 | — |
| `3991b67a17de` | feat(gateway): add scoped investigation evidence and model calls | 7 | 445 / 59 / 504 | 445 / 59 / 504 | — |
| `7a076b4066a6` | feat(gateway): adapt hosted model provider requests | 7 | 208 / 97 / 305 | 208 / 97 / 305 | — |
| `9963b64d9583` | feat(sca): add static JS dependency reachability | 1 | 301 / 0 / 301 | 301 / 0 / 301 | — |

## Continuation review notes

Each new commit above a threshold has a concise reason for its size:

- `956cd0e396e5`: pairs candidate-tree and workflow validation with symlink and policy regressions in the git adapter.
- `0c377c118e60`: adds one backend notification outbox service plus its public export.
- `38e74ef88c43`: adds a single coordinator module for signed webhook and SMTP delivery.
- `edaeaee898de`: adds one end-to-end test for delivery against live notification services.
- `209ebc5b2bc0`: extends candidate preparation across correction and validation facts in three focused backend modules.
- `751735ee5d7d`: introduces the shared lockfile parser for npm, pnpm, and Yarn alongside advisory typing.
- `3991b67a17de`: adds the D11 gateway's scoped investigation reads and model-call service path, migration, and Postgres coverage.
- `7a076b4066a6`: implements replaceable hosted model request handling and its capability-focused tests.
- `9963b64d9583`: adds one bounded static JavaScript dependency-reachability module.
- `debadba43fbd`: stores generated evaluation JSON; all 11,746 raw lines are excluded from authored totals.
- `1f4e4af63430`: imports the pinned upstream Gitleaks configuration; original Semgrep rules and licensing material account for the remaining 155 authored lines.
- `7513a2f39749`: vendors the official CycloneDX schema for offline SBOM validation; the one README line remains authored.

## Recent milestone: `7cbf3ed6cf977c55a17517f92c8d2ddecefa1816..8b940a853d2c94af08447ce4ec69eadd437cb577`

This exclusive-left, inclusive-right range contains **302 commits**. It records GitHub onboarding and the local installer; validation artifacts and workflow exceptions; executor-backed exact approvals and live dependency PRs; runtime protection, monitoring alerts, and workspace decision history; Kubernetes and Trivy fixes; D15 triage evaluation; npm fix candidates, container/SAST coverage, SBOM and license controls; two-click onboarding; D12 dependency reachability; D11 investigation and hosted provider presets; Google sign-in; D14 retention and backup; and remaining-work documentation. These are repository changes, not a claim that every workflow has production verification.

Maximum raw changed lines: **11,746** (`debadba43fbd`, generated evaluation artifacts). Maximum authored changed lines: **531** (`751735ee5d7d`, lockfile parser). No commit in this continuation exceeds 1,000 authored lines.

## Recent milestone: `8a7a43cfd07d30da52f59d9bdfe49e78d2752ce2..8c03aca79c9d60aa750f72818611131f86d55bfe`

This exclusive-left, inclusive-right range contains 20 commits. Maximum raw changed lines: **288** (`25a06f1909d5`); maximum authored changed lines: **288** (`25a06f1909d5`).

| UTC committer time | Commit | Subject | Raw + / − / total | Authored + / − / total |
|---|---|---|---:|---:|
| 2026-10-24 13:49:28 | `1e7ca8cedf60` | feat(customer-assessment): report path-specific HTTPS findings | 71 / 8 / 79 | 71 / 8 / 79 |
| 2026-10-24 13:49:28 | `00b2c5cc277f` | test(customer-assessment): cover path-bound HTTPS findings | 166 / 0 / 166 | 166 / 0 / 166 |
| 2026-10-24 13:50:56 | `6ec889c4df60` | fix(web): show external evidence in clean reports | 258 / 4 / 262 | 258 / 4 / 262 |
| 2026-10-24 13:50:56 | `dc7352feb2d9` | fix(ui): refresh incident views while open | 7 / 4 / 11 | 7 / 4 / 11 |
| 2026-10-24 13:56:57 | `25a06f1909d5` | feat(customer-assessment): orchestrate runs through LangGraph | 249 / 39 / 288 | 249 / 39 / 288 |
| 2026-10-24 13:56:57 | `1dd7aaf039be` | test(customer-assessment): cover graph lifecycle and privacy | 236 / 1 / 237 | 236 / 1 / 237 |
| 2026-10-24 13:57:49 | `1638c3570751` | test(customer-applications): cover public surface pipeline | 75 / 5 / 80 | 75 / 5 / 80 |
| 2026-10-24 13:58:16 | `5863578ca888` | build: lock assessment graph runtime dependency | 3 / 0 / 3 | 0 / 0 / 0 |
| 2026-10-24 14:03:26 | `acdbf3c1968b` | fix(test): use workspace-scoped job status route | 3 / 1 / 4 | 3 / 1 / 4 |
| 2026-10-24 14:08:28 | `d6b693e704c4` | docs(assessment): record deterministic pipeline milestone | 41 / 5 / 46 | 41 / 5 / 46 |
| 2026-10-24 14:11:54 | `ba2281b1d4df` | fix(coordinator): preserve first runtime metrics snapshot | 34 / 30 / 64 | 34 / 30 / 64 |
| 2026-10-24 14:11:54 | `60551a1a8214` | test(coordinator): cover stable runtime window metrics | 93 / 12 / 105 | 93 / 12 / 105 |
| 2026-10-24 14:15:04 | `7678ffdee8b5` | fix(web): keep mobile nav labels inside cells | 1 / 1 / 2 | 1 / 1 / 2 |
| 2026-10-24 14:15:46 | `c97fd23cca31` | feat(customer-assessment): gate Helmet CSP candidates | 234 / 8 / 242 | 234 / 8 / 242 |
| 2026-10-24 14:15:46 | `55f04b377bc7` | test(customer-assessment): cover gated CSP correlation | 282 / 2 / 284 | 282 / 2 / 284 |
| 2026-10-24 14:15:46 | `87a586203556` | docs(customer-assessment): explain Helmet CSP gate limits | 2 / 2 / 4 | 2 / 2 / 4 |
| 2026-10-24 14:16:18 | `1bfc104d0885` | build: lock the assessment syntax parser | 3 / 0 / 3 | 0 / 0 / 0 |
| 2026-10-24 14:21:45 | `d11fd396f320` | test(customer-applications): accept discovered startup orgs | 2 / 1 / 3 | 2 / 1 / 3 |
| 2026-10-24 14:28:01 | `dc5e74b128ba` | docs(validation): record final assessment evidence | 40 / 19 / 59 | 40 / 19 / 59 |
| 2026-10-24 14:28:01 | `8c03aca79c9d` | docs(validation): clarify final evidence details | 6 / 6 / 12 | 6 / 6 / 12 |


## Continuation through fixed endpoint `e2fe67e692117726a27951b58b03f20cf9001561`

The exclusive-left, inclusive-right range `8c03aca79c9d60aa750f72818611131f86d55bfe..e2fe67e692117726a27951b58b03f20cf9001561` contains **23 commits** (355 reachable total). Raw and authored totals are both **1,586 added, 141 deleted, 1,727 changed lines**; no excluded lockfile, generated, or fixture-data paths changed in this range. The maximum is **283 lines** raw and authored, in root commit `67864482f37a` (`test(scanner): verify production TLS scan persistence`). No continuation commit exceeds 300 authored lines or 1,000 raw/authored lines. The six ledger commits in this range are listed with their root ancestry SHAs in [part 4](commit-history-004.md).

## Pre-merge continuation through fixed endpoint `7cbf3ed6cf977c55a17517f92c8d2ddecefa1816`

The exclusive-left, inclusive-right range `e2fe67e692117726a27951b58b03f20cf9001561..7cbf3ed6cf977c55a17517f92c8d2ddecefa1816` contains **18 commits** (373 reachable total). Raw and authored totals are **1,217 added, 134 deleted, 1,351 changed lines**; no lockfile, generated, fixture-data, or binary paths changed in this range. The range begins with ledger commit `15518302316b` and contains 17 focused corrections. Its sole commit above 300 authored lines is `e797c16d00cc` at **323 lines** (314 additions, 9 deletions), a test-heavy cleanup-quarantine exception. None exceeds 1,000 raw or authored lines. The oldest 728-line corpus rebuild remains the largest commit in the exact 234-commit original-main range `5d5c35f05f84..7cbf3ed6cf97`; that range has no commit above 1,000 lines. The continuation rows use root ancestry SHAs in [part 5](commit-history-005.md). Its fixed inventory endpoint is the product correction `7cbf3ed6cf977c55a17517f92c8d2ddecefa1816`; later documentation commits are intentionally excluded.
