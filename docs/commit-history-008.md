# Commit history inventory: 594–675 of 675

Continuation commits after the fixed pre-merge endpoint, ordered by committer timestamp in UTC with parents first when timestamps tie. The SHA values are from the root ancestry. See [the index](commit-history.md) for measurement rules.

Exact range: `7cbf3ed6cf977c55a17517f92c8d2ddecefa1816..8b940a853d2c94af08447ce4ec69eadd437cb577` (exclusive baseline, inclusive endpoint); 302 commits across parts 6–8. This file contains rows 594–675.

| UTC committer time | Commit | Subject | Files | Raw + / − / total | Authored + / − / total | Binary files | Flags |
|---|---|---|---:|---:|---:|---:|---|
| 2026-10-24 20:59:57 | `4c6f86f89be6` | feat(database): persist model probe reservations | 1 | 25 / 0 / 25 | 25 / 0 / 25 | 0 | — |
| 2026-10-24 21:00:10 | `f26c8d04ed2b` | feat(backend): authorize hosted model probes | 3 | 88 / 10 / 98 | 88 / 10 / 98 | 0 | — |
| 2026-10-24 21:00:10 | `ed3dab416590` | test(backend): protect model key authorization | 2 | 75 / 1 / 76 | 75 / 1 / 76 | 0 | — |
| 2026-10-24 21:00:10 | `9563b7624ec9` | feat(gateway): honor provider request capabilities | 3 | 23 / 9 / 32 | 23 / 9 / 32 | 0 | — |
| 2026-10-24 21:00:10 | `8079668f4948` | feat(gateway): reserve and settle model probes | 2 | 288 / 5 / 293 | 288 / 5 / 293 | 0 | — |
| 2026-10-24 21:00:10 | `0cfcdec59c48` | feat(gateway): expose signed model probe route | 4 | 39 / 2 / 41 | 39 / 2 / 41 | 0 | — |
| 2026-10-24 21:00:10 | `2e2c92b94641` | feat(web): connect owner probes through gateway | 3 | 66 / 3 / 69 | 66 / 3 / 69 | 0 | — |
| 2026-10-24 21:00:10 | `13478c2912df` | feat(web): add hosted investigator provider settings | 1 | 70 / 34 / 104 | 70 / 34 / 104 | 0 | — |
| 2026-10-24 21:00:10 | `0aaac17283d3` | docs: document hosted investigator providers | 3 | 38 / 8 / 46 | 38 / 8 / 46 | 0 | — |
| 2026-10-24 21:01:10 | `60a13d74d2de` | fix(web): drop duplicate supply-chain import after retention merge | 1 | 0 / 1 / 1 | 0 / 1 / 1 | 0 | — |
| 2026-10-24 21:12:22 | `4b6cff8d33fc` | docs: track remaining work and sandbox lab decision | 1 | 79 / 0 / 79 | 79 / 0 / 79 | 0 | — |
| 2026-10-24 21:15:45 | `a0b457224151` | docs: defer browser walkthrough and copy pass to production | 1 | 12 / 7 / 19 | 12 / 7 / 19 | 0 | — |
| 2026-10-24 21:17:04 | `57622a884b48` | docs: defer approval revocation, deletion and Google linking | 1 | 3 / 3 / 6 | 3 / 3 / 6 | 0 | — |
| 2026-10-24 21:18:46 | `dad75e1cfb34` | docs: drop Google account linking from pending work | 1 | 0 / 1 / 1 | 0 / 1 / 1 | 0 | — |
| 2026-10-24 21:23:58 | `20b814e44f6f` | fix(backend): return exact scope in execution claims | 3 | 57 / 24 / 81 | 57 / 24 / 81 | 0 | — |
| 2026-10-24 21:23:58 | `a677610abcb2` | feat(contracts): bind source PR actions to candidate tree | 1 | 1 / 1 / 2 | 1 / 1 / 2 | 0 | — |
| 2026-10-24 21:23:58 | `69a5c02ea386` | feat(git-adapters): verify exact PR trees and conditional writes | 1 | 42 / 10 / 52 | 42 / 10 / 52 | 0 | — |
| 2026-10-24 21:23:58 | `fe41020d0eb4` | feat(database): persist PR policy and executor state | 2 | 106 / 0 / 106 | 106 / 0 / 106 | 0 | — |
| 2026-10-24 21:23:58 | `cf3dd7b65d82` | feat(backend): gate exact PR approvals on live policy | 8 | 202 / 60 / 262 | 202 / 60 / 262 | 0 | — |
| 2026-10-24 21:23:58 | `6abf52aea401` | feat(executor): reconcile exact approved PR actions | 1 | 296 / 0 / 296 | 296 / 0 / 296 | 0 | — |
| 2026-10-24 21:23:58 | `bdf201196505` | feat(executor): publish approved source patches as GitHub PRs | 1 | 133 / 0 / 133 | 133 / 0 / 133 | 0 | — |
| 2026-10-24 21:23:58 | `3f4aab8cd242` | feat(executor): run v2 PR jobs in an independent worker | 6 | 227 / 4 / 231 | 227 / 4 / 231 | 0 | — |
| 2026-10-24 21:23:58 | `2e22462a272b` | test(executor): cover exact PR publish and recovery states | 1 | 187 / 0 / 187 | 187 / 0 / 187 | 0 | — |
| 2026-10-24 21:23:58 | `b79a6b467a30` | test(executor): verify durable PR recovery with Postgres and Redis | 2 | 214 / 12 / 226 | 214 / 12 / 226 | 0 | — |
| 2026-10-24 21:23:58 | `a743fbe5b56b` | test(executor): add opt-in live writer App sandbox check | 1 | 237 / 0 / 237 | 237 / 0 / 237 | 0 | — |
| 2026-10-24 21:24:08 | `2672e191ae7d` | feat(coordinator): dispatch PR approvals to executor lane | 2 | 4 / 2 / 6 | 4 / 2 / 6 | 0 | — |
| 2026-10-24 21:24:19 | `79b0e2a1e476` | feat(infra): run isolated executor with writer credentials | 3 | 70 / 14 / 84 | 70 / 14 / 84 | 0 | — |
| 2026-10-24 21:24:19 | `db704d767824` | feat(web): approve exact PR actions with WebAuthn | 4 | 47 / 21 / 68 | 47 / 21 / 68 | 0 | — |
| 2026-10-24 21:24:38 | `56c3176c0b68` | docs(executor): document PR approval rollout state | 3 | 63 / 30 / 93 | 63 / 30 / 93 | 0 | — |
| 2026-10-24 21:24:38 | `fbc15a8a81cd` | build: sync executor validation workspace dependencies | 1 | 29 / 2 / 31 | 0 / 0 / 0 | 0 | — |
| 2026-10-24 21:24:54 | `b1925912a729` | feat(backend): require verified Writer App grants | 6 | 216 / 8 / 224 | 216 / 8 / 224 | 0 | — |
| 2026-10-24 21:24:54 | `320dda26a216` | test(backend): cover verified repository write grants | 1 | 76 / 1 / 77 | 76 / 1 / 77 | 0 | — |
| 2026-10-24 21:24:54 | `52e9de810bb3` | feat(backend): dispatch approved dependency PRs | 4 | 19 / 15 / 34 | 19 / 15 / 34 | 0 | — |
| 2026-10-24 21:25:25 | `29729bbb7e51` | feat(web): manage repository write access with WebAuthn | 7 | 68 / 6 / 74 | 68 / 6 / 74 | 0 | — |
| 2026-10-24 21:25:25 | `ae63051618a4` | feat(executor): publish exact D06 dependency candidates | 5 | 151 / 34 / 185 | 151 / 34 / 185 | 0 | — |
| 2026-10-24 21:25:25 | `90579b80581d` | test(executor): cover dependency PR reconciliation | 2 | 34 / 6 / 40 | 34 / 6 / 40 | 0 | — |
| 2026-10-24 21:25:25 | `e12296c23e34` | test(executor): exercise live source and D06 PR delivery | 1 | 206 / 62 / 268 | 206 / 62 / 268 | 0 | — |
| 2026-10-24 21:25:25 | `5e256d184e09` | feat(web): allow Owner approval of dependency PRs | 1 | 7 / 6 / 13 | 7 / 6 / 13 | 0 | — |
| 2026-10-24 21:25:25 | `b30fc17ebf55` | test(backend): align Postgres suites with PR grants | 6 | 53 / 34 / 87 | 53 / 34 / 87 | 0 | — |
| 2026-10-24 21:25:25 | `0b16f367d57d` | fix(infra): wire private Writer App verification | 6 | 157 / 36 / 193 | 157 / 36 / 193 | 0 | — |
| 2026-10-24 21:25:38 | `829e4a5c8440` | docs(executor): explain grants and live PR evidence | 4 | 43 / 33 / 76 | 43 / 33 / 76 | 0 | — |
| 2026-10-24 21:25:50 | `7fe47250028d` | fix(infra): keep executor on loopback host | 6 | 37 / 143 / 180 | 37 / 143 / 180 | 0 | — |
| 2026-10-24 21:25:50 | `9ecdc2b7ea33` | feat(contracts): model dependency reachability and artifact evidence | 3 | 69 / 1 / 70 | 69 / 1 / 70 | 0 | — |
| 2026-10-24 21:25:50 | `e40976bd8794` | feat(sca): retain lock integrity and OSV symbols | 4 | 66 / 8 / 74 | 66 / 8 / 74 | 0 | — |
| 2026-10-24 21:25:50 | `9963b64d9583` | feat(sca): add static JS dependency reachability | 1 | 301 / 0 / 301 | 301 / 0 / 301 | 0 | auth>300 |
| 2026-10-24 21:25:50 | `d96eedc2bc66` | test(sca): cover JS dependency reachability controls | 1 | 90 / 0 / 90 | 90 / 0 / 90 | 0 | — |
| 2026-10-24 21:25:50 | `7d103a7bfe9c` | feat(sca): add bounded npm artifact verification | 1 | 236 / 0 / 236 | 236 / 0 / 236 | 0 | — |
| 2026-10-24 21:25:50 | `e1383c157dca` | test(sca): reject tampered and unsafe npm archives | 1 | 78 / 0 / 78 | 78 / 0 / 78 | 0 | — |
| 2026-10-24 21:25:50 | `977c134d2977` | feat(sca): include reachability and artifact analysis in reports | 3 | 226 / 21 / 247 | 226 / 21 / 247 | 0 | — |
| 2026-10-24 21:25:50 | `84cf614d1de8` | test(sca): cover advisory reachability report behavior | 1 | 50 / 0 / 50 | 50 / 0 / 50 | 0 | — |
| 2026-10-24 21:25:50 | `8d53cb3c0cbe` | feat(scanner): scan prioritized npm artifacts | 3 | 27 / 3 / 30 | 27 / 3 / 30 | 0 | — |
| 2026-10-24 21:25:50 | `339837a9944c` | feat(database): persist tenant scoped artifact analyses | 3 | 93 / 0 / 93 | 93 / 0 / 93 | 0 | — |
| 2026-10-24 21:25:50 | `5c4390e29b38` | feat(web): prioritize dependency findings by reachability | 3 | 115 / 6 / 121 | 115 / 6 / 121 | 0 | — |
| 2026-10-24 21:25:50 | `c2b97a870998` | docs(sca): record bounded D12 dependency analysis | 3 | 11 / 8 / 19 | 11 / 8 / 19 | 0 | — |
| 2026-10-24 21:25:50 | `dd1499eaa2a2` | fix(test): bind correction reports to assessment policy | 1 | 4 / 3 / 7 | 4 / 3 / 7 | 0 | — |
| 2026-10-24 21:25:50 | `40c5ae0096e8` | fix(backend): parse D12 advisory evidence for fixes | 2 | 16 / 2 / 18 | 16 / 2 / 18 | 0 | — |
| 2026-10-24 21:25:50 | `a00fe0a9a724` | fix(executor): reuse sandbox link across live PR flows | 1 | 3 / 7 / 10 | 3 / 7 / 10 | 0 | — |
| 2026-10-24 21:25:50 | `4b70ab254cdf` | fix(backend): validate D12 advisory package metadata | 2 | 16 / 2 / 18 | 16 / 2 / 18 | 0 | — |
| 2026-10-24 21:25:50 | `953fb7b073c3` | fix(backend): gate npm fixes on inventory evidence | 1 | 11 / 4 / 15 | 11 / 4 / 15 | 0 | — |
| 2026-10-24 21:25:50 | `356cc1947e09` | fix(backend): fetch complete npm packument metadata | 2 | 14 / 2 / 16 | 14 / 2 / 16 | 0 | — |
| 2026-10-24 21:25:50 | `95ec5241d150` | fix(validator): accept not-requested rescan coverage | 3 | 13 / 3 / 16 | 13 / 3 / 16 | 0 | — |
| 2026-10-24 21:25:50 | `c910fabfd5b6` | fix(validator): scope rescan to applicable capabilities | 3 | 12 / 5 / 17 | 12 / 5 / 17 | 0 | — |
| 2026-10-24 21:25:50 | `e54077cf957e` | test(executor): verify npm artifact in D06 flow | 1 | 3 / 2 / 5 | 3 / 2 / 5 | 0 | — |
| 2026-10-24 21:25:50 | `62d1dcded589` | fix(sca): bind artifact evidence to assessment snapshot | 2 | 55 / 2 / 57 | 55 / 2 / 57 | 0 | — |
| 2026-10-24 21:25:50 | `32b5830ea41a` | fix(validator): retain npm coverage during rescans | 2 | 10 / 4 / 14 | 10 / 4 / 14 | 0 | — |
| 2026-10-24 21:25:50 | `2a9eb0c49f63` | test(executor): assert D06 runner proof binding | 1 | 7 / 0 / 7 | 7 / 0 / 7 | 0 | — |
| 2026-10-24 21:25:50 | `070ed3ed2841` | fix(validator): persist runner cleanup verification | 1 | 3 / 2 / 5 | 3 / 2 / 5 | 0 | — |
| 2026-10-24 21:25:50 | `8dc23a4a372e` | test(executor): retain live PR failure details | 1 | 3 / 2 / 5 | 3 / 2 / 5 | 0 | — |
| 2026-10-24 21:25:50 | `4207c64b9b74` | fix(git-adapters): make deleted branch cleanup idempotent | 2 | 30 / 1 / 31 | 30 / 1 / 31 | 0 | — |
| 2026-10-24 21:25:50 | `868b55544deb` | test(executor): compare D06 verifier roles | 1 | 2 / 0 / 2 | 2 / 0 / 2 | 0 | — |
| 2026-10-24 21:25:50 | `182a4a16121e` | fix(database): grant executor scoped installation reads | 1 | 3 / 0 / 3 | 3 / 0 / 3 | 0 | — |
| 2026-10-24 21:25:50 | `f680454fc448` | fix(database): grant executor repository binding reads | 1 | 4 / 0 / 4 | 4 / 0 / 4 | 0 | — |
| 2026-10-24 21:25:50 | `974a17562e4a` | test(executor): assert empty D06 provider preflight | 1 | 2 / 0 / 2 | 2 / 0 / 2 | 0 | — |
| 2026-10-24 21:25:50 | `669baf9e58aa` | test(executor): capture D06 provider reconciliation | 1 | 11 / 1 / 12 | 11 / 1 / 12 | 0 | — |
| 2026-10-24 21:25:50 | `315a49201610` | fix(test): read stored execution for D06 diagnostics | 1 | 6 / 3 / 9 | 6 / 3 / 9 | 0 | — |
| 2026-10-24 21:25:50 | `7adebeb2506e` | fix(backend): match GitHub dependency commit hashes | 2 | 15 / 2 / 17 | 15 / 2 / 17 | 0 | — |
| 2026-10-24 21:26:08 | `a59ed060b812` | docs(executor): record live D06 PR proof | 1 | 1 / 1 / 2 | 1 / 1 / 2 | 0 | — |
| 2026-10-24 21:30:08 | `82445394e396` | fix: merge duplicate imports left by stream integration | 8 | 9 / 21 / 30 | 9 / 21 / 30 | 0 | — |
| 2026-10-24 21:30:08 | `57192c04b0d9` | fix(test): align fixtures with retention and provider presets | 2 | 2 / 1 / 3 | 2 / 1 / 3 | 0 | — |
| 2026-10-24 21:33:34 | `b04dd69f25c7` | docs: add MCP server and WhatsApp channel to pending work | 1 | 6 / 1 / 7 | 6 / 1 / 7 | 0 | — |
| 2026-10-24 21:35:01 | `cb2cb88abb91` | fix(installer): refresh Trivy database on every start | 1 | 2 / 0 / 2 | 2 / 0 / 2 | 0 | — |
| 2026-10-24 21:35:19 | `8b940a853d2c` | docs: record open verification gaps found during integration | 1 | 10 / 0 / 10 | 10 / 0 / 10 | 0 | — |
