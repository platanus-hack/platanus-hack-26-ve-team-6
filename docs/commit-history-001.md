# Commit history inventory: 1–111 of 332

Fixed-snapshot commits 1 through 111, sorted by committer timestamp in UTC, with parents first when timestamps tie. See [the inventory index](commit-history.md) for scope and measurement rules.

Range: `9b1624f052b9` through `952e3c17f21b`.

| UTC committer time | Commit | Subject | Files | Raw + / − / total | Authored + / − / total | Binary files | Flags |
|---|---|---|---:|---:|---:|---:|---|
| 2026-10-24 04:12:18 | `9b1624f052b9` | docs: record architecture decisions and parallel implementation plan | 6 | 495 / 0 / 495 | 495 / 0 / 495 | 0 | root, auth>300 |
| 2026-10-24 04:12:18 | `89ecf32b142a` | chore: bootstrap TypeScript workspace and event contracts | 7 | 163 / 0 / 163 | 163 / 0 / 163 | 0 | — |
| 2026-10-24 04:15:48 | `9e4bf68966d0` | build: lock workspace dependencies and allow esbuild for pnpm 11 | 2 | 1,063 / 2 / 1,065 | 2 / 2 / 4 | 0 | raw>1k |
| 2026-10-24 04:19:34 | `605bf47898e1` | feat(web): add minimal TanStack Start and verified Auth.js session adapter | 14 | 447 / 0 / 447 | 343 / 0 / 343 | 0 | auth>300 |
| 2026-10-24 04:22:02 | `0872050a6cfe` | feat(sdk): sign bounded event batches and retry delivery safely | 6 | 124 / 0 / 124 | 124 / 0 / 124 | 0 | — |
| 2026-10-24 04:22:02 | `e8aec3365a74` | docs(backend): define framework-independent service integration contract | 5 | 33 / 0 / 33 | 33 / 0 / 33 | 0 | — |
| 2026-10-24 04:22:02 | `3fd4746e4762` | feat(database): enforce tenant isolation and restricted runtime roles | 7 | 514 / 0 / 514 | 514 / 0 / 514 | 0 | auth>300 |
| 2026-10-24 04:22:58 | `d05ceef035df` | docs: add coding preferences for all implementation worktrees | 1 | 150 / 1 / 151 | 150 / 1 / 151 | 0 | — |
| 2026-10-24 04:27:36 | `dd61c142edc5` | feat(backend): authenticate events and deliver durable tenant jobs | 16 | 475 / 29 / 504 | 475 / 29 / 504 | 0 | auth>300 |
| 2026-10-24 04:27:36 | `dc120030597a` | feat(backend): bind approvals to exact independently verified actions | 8 | 396 / 2 / 398 | 396 / 2 / 398 | 0 | auth>300 |
| 2026-10-24 04:27:36 | `bb43744f3790` | feat(backend): reserve model budgets and persist bounded run checkpoints | 3 | 158 / 1 / 159 | 158 / 1 / 159 | 0 | — |
| 2026-10-24 04:29:29 | `b2968d8c067d` | fix(database): reject runtime ownership of Gotchu objects | 2 | 12 / 0 / 12 | 12 / 0 / 12 | 0 | — |
| 2026-10-24 04:29:29 | `3fbff437dc84` | fix(backend): normalize concurrent replay locks and verify effect fencing | 2 | 19 / 5 / 24 | 19 / 5 / 24 | 0 | — |
| 2026-10-24 04:29:29 | `fe8cc5b2a653` | test(backend): make isolated Postgres validation repeatable | 4 | 120 / 13 / 133 | 120 / 13 / 133 | 0 | — |
| 2026-10-24 04:29:55 | `8dae20edc35f` | feat(api): connect authenticated routes to durable backend services | 9 | 2,028 / 46 / 2,074 | 251 / 3 / 254 | 0 | raw>1k |
| 2026-10-24 04:38:48 | `75642ca725a1` | feat(gateway): enforce scoped runs and durable read authorization | 14 | 602 / 0 / 602 | 602 / 0 / 602 | 0 | auth>300 |
| 2026-10-24 04:38:48 | `a896bb8fbfd3` | test(gateway): verify HTTP worker boundaries against Postgres | 5 | 538 / 0 / 538 | 538 / 0 / 538 | 0 | auth>300 |
| 2026-10-24 04:38:48 | `e5d36fe26560` | fix(api): bound slow streaming request bodies | 2 | 20 / 4 / 24 | 20 / 4 / 24 | 0 | — |
| 2026-10-24 04:39:54 | `45c1b6d306d0` | feat(agent): add scoped bounded LangGraph investigations | 9 | 1,463 / 0 / 1,463 | 1,463 / 0 / 1,463 | 0 | raw>1k, auth>300, auth>1k |
| 2026-10-24 04:39:54 | `795117678d24` | fix(agent): continue investigation after read tools | 2 | 50 / 2 / 52 | 50 / 2 / 52 | 0 | — |
| 2026-10-24 04:39:54 | `221d5d9ca567` | test(agent): cover hard model spend limit | 1 | 13 / 0 / 13 | 13 / 0 / 13 | 0 | — |
| 2026-10-24 04:39:54 | `fcd795aa40cf` | feat(worker): add capability-scoped investigation HTTP adapter | 11 | 826 / 0 / 826 | 826 / 0 / 826 | 0 | auth>300 |
| 2026-10-24 04:39:54 | `af345efeeaa5` | docs(worker): clarify gateway checkpoint semantics | 1 | 2 / 2 / 4 | 2 / 2 / 4 | 0 | — |
| 2026-10-24 04:39:54 | `0b69aa6c9a6d` | feat(executor): add independent claim and reconciliation orchestration | 6 | 864 / 0 / 864 | 864 / 0 / 864 | 0 | auth>300 |
| 2026-10-24 04:45:50 | `40e39c473036` | feat(backend): reconcile uncertain executions through restricted ledger | 2 | 171 / 6 / 177 | 171 / 6 / 177 | 0 | — |
| 2026-10-24 04:45:50 | `cf1e65884116` | feat(executor): connect durable backend ledger and verify Postgres integration | 8 | 453 / 13 / 466 | 453 / 13 / 466 | 0 | auth>300 |
| 2026-10-24 04:54:01 | `9176f502acac` | infra: add isolated local data services and checks | 10 | 745 / 0 / 745 | 745 / 0 / 745 | 0 | auth>300 |
| 2026-10-24 04:54:01 | `4856efd25a60` | infra: provision DigitalOcean baseline with policy mocks | 10 | 355 / 0 / 355 | 355 / 0 / 355 | 0 | auth>300 |
| 2026-10-24 04:54:01 | `5e8606fec970` | ci: validate workspace and live infrastructure dependencies | 2 | 122 / 0 / 122 | 122 / 0 / 122 | 0 | — |
| 2026-10-24 04:57:19 | `2b590459de15` | fix(auth): bound anonymous Auth.js request bodies | 2 | 11 / 2 / 13 | 11 / 2 / 13 | 0 | — |
| 2026-10-24 04:57:19 | `9dc86c0fb18b` | fix(contracts): normalize durable job UUID identities | 2 | 12 / 4 / 16 | 12 / 4 / 16 | 0 | — |
| 2026-10-24 04:57:19 | `082914a457fa` | feat(coordinator): deliver durable jobs and fence investigation completion | 11 | 2,707 / 29 / 2,736 | 414 / 2 / 416 | 0 | raw>1k, auth>300 |
| 2026-10-24 04:58:42 | `1029876bbe1f` | test(integration): prove signed delivery recovery and atomic investigation results | 6 | 319 / 13 / 332 | 319 / 13 / 332 | 0 | auth>300 |
| 2026-10-24 04:58:43 | `cb563cbcaed8` | ci: exercise gateway executor and Redis recovery with live dependencies | 1 | 13 / 6 / 19 | 13 / 6 / 19 | 0 | — |
| 2026-10-24 04:58:43 | `8cc78847af14` | docs: record authorized TanStack implementation decisions | 1 | 5 / 3 / 8 | 5 / 3 / 8 | 0 | — |
| 2026-10-24 04:59:55 | `c0a19e123b9b` | fix(deps): satisfy Pulumi tracing peer versions | 2 | 125 / 118 / 243 | 4 / 0 / 4 | 0 | — |
| 2026-10-24 05:02:19 | `2a54793d8971` | fix(coordinator): quarantine invalid times and recover completed checkpoints | 5 | 74 / 12 / 86 | 74 / 12 / 86 | 0 | — |
| 2026-10-24 05:03:21 | `6fddfc656c8d` | docs: align architecture with implemented foundation | 4 | 407 / 181 / 588 | 407 / 181 / 588 | 0 | auth>300 |
| 2026-10-24 05:04:56 | `68244d562ed4` | docs: record integrated foundation checks and unproven gates | 1 | 39 / 0 / 39 | 39 / 0 / 39 | 0 | — |
| 2026-10-24 05:09:11 | `a50073ddca8e` | docs: clarify model gateway accounting and live test prerequisites | 4 | 4 / 4 / 8 | 4 / 4 / 8 | 0 | — |
| 2026-10-24 05:25:21 | `ef61eb74ac51` | Keep deterministic monitoring independent of investigations | 5 | 139 / 27 / 166 | 139 / 27 / 166 | 0 | — |
| 2026-10-24 05:25:58 | `afaebd21305c` | feat(infra): run web and coordinator in Compose | 9 | 431 / 101 / 532 | 431 / 101 / 532 | 0 | auth>300 |
| 2026-10-24 05:27:19 | `883cb2cf549c` | fix(infra): reserve distinct smoke-test ports together | 1 | 15 / 11 / 26 | 15 / 11 / 26 | 0 | — |
| 2026-10-24 05:33:05 | `30dc2f351bd1` | fix(coordinator): reserve event recovery capacity behind investigation backlog | 3 | 29 / 9 / 38 | 29 / 9 / 38 | 0 | — |
| 2026-10-24 05:35:14 | `1a91f440599f` | docs: record runnable foundation and final verification | 6 | 29 / 24 / 53 | 29 / 24 / 53 | 0 | — |
| 2026-10-24 06:03:52 | `e7424ca741b1` | docs: adopt AWS-first portable assessment direction | 1 | 3 / 1 / 4 | 3 / 1 / 4 | 0 | — |
| 2026-10-24 06:05:29 | `535fa54e2a3b` | feat(contracts): bind assessment comparisons to actual scoped evidence | 3 | 177 / 0 / 177 | 177 / 0 / 177 | 0 | — |
| 2026-10-24 06:06:47 | `9a8278b98230` | feat(contracts): scope assessment runner inputs to durable jobs | 1 | 4 / 0 / 4 | 4 / 0 / 4 | 0 | — |
| 2026-10-24 06:11:30 | `b0805950837d` | feat(contracts): define the controlled demonstration API | 2 | 18 / 0 / 18 | 18 / 0 / 18 | 0 | — |
| 2026-10-24 06:15:27 | `67c4075c7b11` | feat(backend): persist scoped controlled assessment requests and reports | 11 | 580 / 6 / 586 | 580 / 6 / 586 | 0 | auth>300 |
| 2026-10-24 06:15:27 | `7a7a19815357` | feat(coordinator): run assessments in a bounded independent delivery lane | 11 | 241 / 11 / 252 | 241 / 11 / 252 | 0 | — |
| 2026-10-24 06:16:23 | `99dbfa939c9b` | feat(demo-target): serve controlled vulnerable and corrected catalogs | 13 | 220 / 0 / 220 | 0 / 0 / 0 | 0 | — |
| 2026-10-24 06:16:23 | `ad6f62882669` | feat(assessment): compare bounded source and live HTTP evidence | 17 | 1,542 / 0 / 1,542 | 1,542 / 0 / 1,542 | 0 | raw>1k, auth>300, auth>1k |
| 2026-10-24 06:16:23 | `819f0ba51ebe` | feat(infra): replace DigitalOcean baseline with AWS pilot foundation | 9 | 605 / 258 / 863 | 605 / 258 / 863 | 0 | auth>300 |
| 2026-10-24 06:23:39 | `4a5fd702c365` | feat(auth): support issuer-scoped OIDC without mandatory GitHub | 2 | 67 / 10 / 77 | 67 / 10 / 77 | 0 | — |
| 2026-10-24 06:23:39 | `29d02e04a965` | feat(web): expose the bounded controlled assessment API | 4 | 169 / 0 / 169 | 169 / 0 / 169 | 0 | — |
| 2026-10-24 06:24:09 | `7fe3c0d4b3f7` | feat(coordinator): wire the fixed assessment runner and private demo target | 2 | 12 / 2 / 14 | 12 / 2 / 14 | 0 | — |
| 2026-10-24 06:24:09 | `93e3fd56cf73` | feat(dashboard): run assessments and inspect persisted evidence | 7 | 415 / 14 / 429 | 361 / 12 / 373 | 0 | auth>300 |
| 2026-10-24 06:26:34 | `8554554ad60f` | fix(contracts): keep partial assessment contrasts unverified | 2 | 12 / 2 / 14 | 12 / 2 / 14 | 0 | — |
| 2026-10-24 06:26:34 | `e0593f298636` | fix(auth): bound OIDC principals without truncating subjects | 2 | 26 / 2 / 28 | 26 / 2 / 28 | 0 | — |
| 2026-10-24 06:26:34 | `bf6a1053b444` | feat(dev): start the real controlled demo with recorded process ownership | 3 | 153 / 7 / 160 | 105 / 1 / 106 | 0 | — |
| 2026-10-24 06:27:54 | `ec69dbca811c` | test: cover controlled assessments over the live pipeline | 1 | 395 / 0 / 395 | 395 / 0 / 395 | 0 | auth>300 |
| 2026-10-24 06:28:25 | `775a068486e5` | fix(dashboard): improve mobile reading and disclose report scope clearly | 3 | 67 / 64 / 131 | 67 / 64 / 131 | 0 | — |
| 2026-10-24 06:30:00 | `e13bd1384c53` | Package assessment runtime in coordinator image | 1 | 10 / 2 / 12 | 10 / 2 / 12 | 0 | — |
| 2026-10-24 06:30:00 | `59532ae98279` | Configure opt-in demo runtime for Compose | 4 | 125 / 5 / 130 | 125 / 5 / 130 | 0 | — |
| 2026-10-24 06:31:55 | `c2f23f7805aa` | fix(auth): accept an omitted OIDC display name in Compose | 2 | 2 / 2 / 4 | 2 / 2 / 4 | 0 | — |
| 2026-10-24 06:32:02 | `b3f5e5ec3996` | test(infra): exercise bundled assessment resources inside the runtime image | 2 | 4 / 0 / 4 | 4 / 0 / 4 | 0 | — |
| 2026-10-24 06:33:24 | `810c885c2ce0` | docs: describe controlled assessment demo | 5 | 244 / 276 / 520 | 244 / 276 / 520 | 0 | auth>300 |
| 2026-10-24 06:36:35 | `40018555ede9` | fix(dashboard): show the exact reports used for revision comparison | 2 | 4 / 3 / 7 | 4 / 3 / 7 | 0 | — |
| 2026-10-24 06:36:35 | `6f1ecadf4bd8` | docs: record integrated assessment checks and operational limits | 4 | 52 / 6 / 58 | 52 / 6 / 58 | 0 | — |
| 2026-10-24 06:43:51 | `6695e8850d39` | docs: restore the actual customer application as the product scope | 2 | 7 / 3 / 10 | 7 / 3 / 10 | 0 | — |
| 2026-10-24 06:46:15 | `6ba2314cc1c5` | Define customer assessment contracts and service integration boundary | 4 | 105 / 5 / 110 | 105 / 5 / 110 | 0 | — |
| 2026-10-24 06:53:26 | `7d2d48b28d55` | feat(auth): add persisted local accounts and revocable Auth.js sessions | 5 | 238 / 5 / 243 | 238 / 5 / 243 | 0 | — |
| 2026-10-24 06:58:43 | `844920268a79` | Bound real source snapshots and separate durable assessment intent | 2 | 71 / 6 / 77 | 71 / 6 / 77 | 0 | — |
| 2026-10-24 06:58:43 | `c9b2ca11b2ad` | Persist customer workspaces and versioned assessment authorization | 4 | 289 / 0 / 289 | 289 / 0 / 289 | 0 | — |
| 2026-10-24 06:58:43 | `fd2c89420eb6` | Add authenticated customer assessments with fenced report completion | 5 | 675 / 6 / 681 | 675 / 6 / 681 | 0 | auth>300 |
| 2026-10-24 06:58:43 | `c16e677a59cb` | Assess customer source and public HTTPS with bounded real scanners | 17 | 660 / 0 / 660 | 660 / 0 / 660 | 0 | auth>300 |
| 2026-10-24 06:58:43 | `b7a81921870f` | Serve customer assessments through an authenticated scanner client | 10 | 240 / 0 / 240 | 240 / 0 / 240 | 0 | — |
| 2026-10-24 06:58:43 | `55bf0b6fa908` | Preserve partial evidence when scanner capabilities are incomplete | 2 | 11 / 1 / 12 | 11 / 1 / 12 | 0 | — |
| 2026-10-24 07:04:35 | `c268ce3333f3` | fix(api): retire audits that bypass explicit customer assessment scope | 5 | 17 / 18 / 35 | 17 / 18 / 35 | 0 | — |
| 2026-10-24 07:04:35 | `f4efa4dad79f` | fix(auth): commit registration admission before password derivation | 2 | 15 / 0 / 15 | 15 / 0 / 15 | 0 | — |
| 2026-10-24 07:04:35 | `1dbf9a0c1243` | feat(api): connect authenticated workspaces and authorized assessment flows | 6 | 254 / 4 / 258 | 233 / 4 / 237 | 0 | — |
| 2026-10-24 07:04:35 | `a02ac2e0aa1c` | feat(coordinator): discover customer work and dispatch isolated scans | 7 | 97 / 16 / 113 | 67 / 16 / 83 | 0 | — |
| 2026-10-24 07:09:08 | `d91a1f3888cc` | fix(scanners): enforce the development-only parser release gate | 3 | 17 / 0 / 17 | 17 / 0 / 17 | 0 | — |
| 2026-10-24 07:09:08 | `3189684554b9` | fix(auth): share the runtime account provider across HTTP entry points | 3 | 22 / 15 / 37 | 22 / 15 / 37 | 0 | — |
| 2026-10-24 07:09:08 | `d56a4fc2414e` | feat(web): add authenticated customer workspace dashboard | 5 | 1,249 / 3 / 1,252 | 1,249 / 3 / 1,252 | 0 | raw>1k, auth>300, auth>1k |
| 2026-10-24 07:09:08 | `27c7e4226e2f` | fix(web): match customer source deletion route | 2 | 7 / 6 / 13 | 7 / 6 / 13 | 0 | — |
| 2026-10-24 07:10:28 | `53daff7b29d3` | test: expose isolated runtime connections for process-level checks | 1 | 4 / 1 / 5 | 4 / 1 / 5 | 0 | — |
| 2026-10-24 07:13:54 | `7171c321428b` | fix(auth): rebuild native requests at the Nitro transport boundary | 1 | 1 / 1 / 2 | 1 / 1 / 2 | 0 | — |
| 2026-10-24 07:15:15 | `bc25705bad3f` | fix(scanner): retain admission through cleanup and coalesce readiness | 13 | 302 / 38 / 340 | 302 / 38 / 340 | 0 | auth>300 |
| 2026-10-24 07:15:15 | `e3b835b43166` | fix(assessment): keep omitted configuration coverage unknown | 4 | 57 / 6 / 63 | 57 / 6 / 63 | 0 | — |
| 2026-10-24 07:15:15 | `d9f4e38089df` | fix(assessment): recheck target authorization after DNS | 4 | 39 / 7 / 46 | 39 / 7 / 46 | 0 | — |
| 2026-10-24 07:17:27 | `b757a6fb9a88` | test: exercise customer applications through live service processes | 1 | 437 / 0 / 437 | 437 / 0 / 437 | 0 | auth>300 |
| 2026-10-24 07:18:46 | `cf3d2959c2c3` | Add local customer app development starter | 2 | 680 / 0 / 680 | 680 / 0 / 680 | 0 | auth>300 |
| 2026-10-24 07:30:49 | `b9169214aa95` | fix(assessment): preserve unassessed advisory severity | 7 | 10 / 6 / 16 | 10 / 6 / 16 | 0 | — |
| 2026-10-24 07:30:55 | `2215ef7d1bf0` | fix(web): isolate workspace state across account sessions | 3 | 36 / 23 / 59 | 36 / 23 / 59 | 0 | — |
| 2026-10-24 07:32:21 | `02237402ca76` | fix(dev): verify the rendered customer dashboard before reporting ready | 5 | 43 / 34 / 77 | 43 / 34 / 77 | 0 | — |
| 2026-10-24 07:33:16 | `07513c072b7b` | fix(backend): block target changes while assessment work is outstanding | 3 | 147 / 3 / 150 | 147 / 3 / 150 | 0 | — |
| 2026-10-24 07:33:16 | `d0f22fe8223d` | docs: document customer assessment application | 4 | 208 / 213 / 421 | 208 / 213 / 421 | 0 | auth>300 |
| 2026-10-24 07:34:45 | `b8c09fc24e49` | fix(coordinator): quarantine uncertain customer scans before releasing authorization | 5 | 65 / 4 / 69 | 65 / 4 / 69 | 0 | — |
| 2026-10-24 07:34:45 | `58ffae782e3b` | fix(infra): include customer scanner client dependencies in coordinator image | 1 | 7 / 0 / 7 | 7 / 0 / 7 | 0 | — |
| 2026-10-24 07:36:38 | `225c3d67c32b` | fix(coordinator): quarantine recovered scans before checking configuration | 2 | 8 / 1 / 9 | 8 / 1 / 9 | 0 | — |
| 2026-10-24 07:36:38 | `f0f990182b1c` | test(assessment): retain the process while waiting for abort deadlines | 1 | 7 / 3 / 10 | 7 / 3 / 10 | 0 | — |
| 2026-10-24 07:36:38 | `59564883b196` | test(web): assert the actual dashboard route title | 1 | 1 / 1 / 2 | 1 / 1 / 2 | 0 | — |
| 2026-10-24 07:38:05 | `7bb07c808d57` | docs: explain target quarantine and workspace admission bounds | 4 | 12 / 5 / 17 | 12 / 5 / 17 | 0 | — |
| 2026-10-24 07:39:30 | `bef829ad3ab2` | docs: record actual customer workflow and live security validation | 1 | 48 / 1 / 49 | 48 / 1 / 49 | 0 | — |
| 2026-10-24 07:42:07 | `aa694ce02213` | feat(api): support source snapshot DELETE with empty 204 responses | 4 | 78 / 4 / 82 | 78 / 4 / 82 | 0 | — |
| 2026-10-24 07:56:03 | `df4b54e530b2` | Define durable monitoring and advisory operations contracts | 3 | 101 / 0 / 101 | 101 / 0 / 101 | 0 | — |
| 2026-10-24 07:59:13 | `e14ce510758f` | feat(assessment): bind public surface profiles to explicit target consent | 5 | 38 / 11 / 49 | 38 / 11 / 49 | 0 | — |
| 2026-10-24 08:04:19 | `4e581d9236ca` | Define healthy coverage and measured operations evidence | 2 | 34 / 6 / 40 | 34 / 6 / 40 | 0 | — |
| 2026-10-24 08:04:19 | `952e3c17f21b` | Persist tenant-scoped monitoring leases and operations evidence | 2 | 268 / 0 / 268 | 268 / 0 / 268 | 0 | — |
