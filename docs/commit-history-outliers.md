# Large-change review and recent milestone

## Threshold summary

- `41` commits exceed 300 authored changed lines. Every one is listed below and marked `auth>300` in the chronological inventory.
- `8` commits exceed 1,000 raw changed lines.
- `5` commits exceed 1,000 authored changed lines.
- `0` binary files changed in the measured history.
- The largest authored change is 2,955 lines in `bb7c955342bd` (`feat(monitoring): add bounded read adapters`).

The fixture-path correction restores 186 authored lines across two otherwise sub-threshold commits: 171 in `99dbfa939c9b` (demo target implementation) and 15 in `bda7955dc8d1` (validator harness). The threshold counts and large-authored rows below remain unchanged.

## Raw outliers with excluded-file contributions

These commits exceed 1,000 raw lines and include large lockfile or generated-file deltas. The authored column applies the precise path exclusions defined in [the index](commit-history.md). The lockfile and generated contributions below are read directly from each commit’s first-parent numstat. No >1,000-raw commit is driven by fixture data.

| Commit | Subject | Raw + / − / total | Authored + / − / total | Excluded contribution |
|---|---|---:|---:|---|
| `9e4bf68966d0` | build: lock workspace dependencies and allow esbuild for pnpm 11 | 1,063 / 2 / 1,065 | 2 / 2 / 4 | `pnpm-lock.yaml` +1,061; workspace manifest +2/−2 remains authored |
| `8dae20edc35f` | feat(api): connect authenticated routes to durable backend services | 2,028 / 46 / 2,074 | 251 / 3 / 254 | `pnpm-lock.yaml` +1,732/−40; generated `apps/web/src/routeTree.gen.ts` +45/−3 |
| `082914a457fa` | feat(coordinator): deliver durable jobs and fence investigation completion | 2,707 / 29 / 2,736 | 414 / 2 / 416 | `pnpm-lock.yaml` +2,293/−27 |

The `9e4bf...` and `8dae20...` commits fall below 300 authored lines (4 and 254). `082914...` has 416 authored lines, so it remains a large authored change even though the lockfile accounts for most raw churn. The other five raw outliers are authored changes above 1,000 lines and appear in the table below.

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
