# Selected Node compatibility profile v1

`node24-tsx-selected-v1` runs explicitly selected, unchanged repository tests for a private source correction. It reports selected compatibility coverage. It does not establish whole-suite coverage, source reachability, exploitation, or a successful security regression reproduction. A vulnerability-specific regression needs separate real evidence; this profile manufactures no regression markers.

The legacy `node24-npm-test` profile still runs `npm test` with its existing artifact behavior. The new profile never invokes the customer's test script. Both seed the read-only, host-verified npm tarball cache, then use `npm ci --ignore-scripts --offline --cache /scratch/npm-cache`. Existing archive, dependency integrity, resource, isolation and cleanup bounds remain in force.

## Runner job integration

`runnerProfileSchema` now accepts both profile names. `RunnerJob` is a discriminated union: legacy jobs forbid a non-undefined `testSelection`; selected jobs require this strict object:

```ts
{
  files: string[];       // 1..20 unique regular files present in the input archive
  namePattern?: string; // 1..256 characters, valid regex, no control characters
}
```

File paths have at most 512 characters, use `/` repository-relative segments, and cannot contain traversal, empty segments, backslashes, whitespace, shell punctuation, a leading option, or `node_modules` segments. They match `*.test.{js,ts,mjs,cjs,mts,cts,jsx,tsx}` or the corresponding `*.spec.*` convention. Paths and file existence are checked before host dependency fetching. Empty regular files are valid inputs but cannot establish executed-test success.

The root integration owns suite versioning, persistence and authorization. It must bind the exact selection to the suite/job, carry it unchanged to base and candidate, and pin selected test contents and supporting test configuration against the approved base. This runner receives one snapshot at a time and cannot independently establish cross-snapshot equality. Changes to application source do not authorize changed tests or commands.

Guest argv is fixed, with each name pattern and filename passed as its own argument:

```text
/usr/local/bin/node
  --import /usr/local/lib/gotchu-node-selected/node_modules/tsx/dist/loader.mjs
  --test
  [--test-name-pattern <literal pattern>]
  --test-reporter=spec --test-reporter-destination=stdout
  --test-reporter=/usr/local/lib/gotchu-node-selected-reporter.mjs
  --test-reporter-destination=stdout
  /scratch/work/<selected file> ...
```

The absolute loader path resolves the runner-owned `tsx` export; a customer `node_modules/tsx` cannot replace that parent loader. The existing fixed PID-limit shell wrapper only forwards this argv; selection never chooses a shell or command. The selected guest remounts `/` read-only before installation/test execution. `/tmp` is backed by the bounded scratch disk so tests can generate fixtures without writing to the pinned image.

## Structured artifact contract

`SELECTED_NODE_REPORT_PATH` is `test-results/gotchu-node-selected-v1.json`. Its UTF-8 JSON is bounded to 4096 bytes and validated by exported `selectedNodeTestReportSchema`:

```ts
{
  schemaVersion: 1;
  profile: 'node24-tsx-selected-v1';
  complete: boolean;
  success: boolean;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    cancelled: number;
    total: number;
  };
}
```

Every count is an integer in `0..1_000_000`. `total` equals the sum of the other four fields. Counts exclude suites. TODOs are included in `skipped` and always make `success` false. `complete` and `success` are separate: an observed failed test can have complete counts and unsuccessful execution.

The fixed reporter consumes Node events, not formatted console output. It waits for stream end, requires one terminal global `test:summary`, and reconciles counts with the completed per-file summaries (at most 20 distinct files). Forwarded child summaries use Node's `entryFile` identity, with `file` as a fallback; a missing child source location alone cannot establish global completion. Missing, duplicate, contradictory or interrupted completion becomes an incomplete unsuccessful report. Reconciliation rejects Node's implicit successful file wrapper when a file registers no tests. A thrown reporter stream produces no successful completion. Event shapes and accounting were read from the pinned Node 24.22.1 documentation/source; authored regression sources still require execution against the built image.

Node 24.22.1 `Test.postRun()` emits the plan, diagnostics and optional coverage before the summary, then ends the stream. `FileTest.#handleReportItem()` stamps `entryFile` on forwarded child events. `countCompletedTest()` excludes suites and counts SKIP/TODO before cancellation and failure. Events after the global summary remain invalid; the source does not justify accepting trailing diagnostics.

An incomplete stream now emits one `GOTCHU_SELECTED_REPORT_INCOMPLETE` diagnostic on stderr containing a fixed reason, file-summary count, and numeric file/global counts (or null for an invalid global summary). It includes no test paths, names, stdout or customer errors and does not alter the strict report artifact. The actual base VM completed in 115465 ms with exit 1, verified cleanup, untruncated output and 14 failed tests reporting `ENETUNREACH`; its artifact was incomplete with zero counts. The saved result has no Node event trace, so the exact reporter rejection is unresolved. The new entry-file regression is synthetic compatibility coverage, not a reproduced explanation of that VM result. Root must inspect the next actual VM diagnostic if completion remains incomplete.

The custom reporter writes JSON to fd 3, a dedicated agent pipe, and emits no structured data to stdout. The spec reporter goes to capped stdout for diagnostics. Node's default process isolation does not pass fd 3 to test subprocesses. The agent bounds the dedicated channel and rejects missing, malformed, truncated or oversized data. On subprocess close, a nonzero exit, signal or exceeded stdout/stderr cap forces `success` false. Zero passed tests, failures, cancellation, TODOs or an unsuccessful Node summary cannot produce exit code 0.

The root guest agent inserts the reserved artifact directly into the result envelope and ignores any customer entry at that exact path, including symlinks or directories. It does not read a customer file as the report or rewrite customer tests. The reserved artifact consumes one of the existing 10 artifact slots and its bytes count against the 256 KiB aggregate cap. Host validation verifies artifact digest/size, strict report structure, and complete successful nonempty counts before accepting selected-profile exit code 0. A resource/infrastructure/cleanup failure remains unsuccessful even if a prior report existed.

The root validator must require this exact artifact for **both base and candidate**, plus completed runner status, exit code 0, no output truncation, verified cleanup and valid isolation provenance. It must require `complete === true`, `success === true`, `passed > 0`, `failed === 0`, `cancelled === 0`; arbitrary customer JSON artifacts are not an alternative for this profile. Artifacts remain guest evidence, not independent proof against a compromised VM/runtime or proof of exploitation.

## Maintainer build and fresh canary after review

No image was built or hash changed during this implementation. `images.lock.json` still pins the previous guest. It cannot supply the new profile until root reviews the guest/toolchain sources, performs an actual build and pins the resulting measured rootfs digest.

The loopback/reporting follow-up also leaves the image pin unchanged and runs no checks. Root must rebuild and pin these sources, obtain a fresh canary that still denies `1.1.1.1`, then run the authored HTTP regressions in both profiles and repeat the actual selected base/candidate runs. HTTP on `127.0.0.1` should succeed entirely within the VM; no result is presumed green. The JSON schema, selected argv, approval contract, and legacy npm execution/report semantics are unchanged.

The image includes tsx 4.23.15, esbuild 0.28.2 and the Linux x64 esbuild binary. Their exact tarball SHA-512 integrities are in `guest/node-toolchain.lock.json`, matching the repository lockfile and published registry metadata read on 2026-10-25. tsx 4.23.15 depends on esbuild `~0.28.0`; its optional fsevents is for macOS. This version has no get-tsconfig dependency. Other esbuild platform packages are unnecessary for this fixed Linux x64 image. Preparation downloads and verifies these fixed tarballs and extracts them; it does not execute their lifecycle scripts or downloaded package code on the host. Actual resolution, native-binary compatibility and event behavior remain VM checks.

After review, root can run the following from a shell with the required KVM/group/tool access, using its own private directory. These are instructions, not a record of execution:

```sh
export GOTCHU_RUNNER_CACHE_DIR="$(mktemp -d /tmp/gotchu-runner-selected.XXXXXX)"
pnpm --filter @gotchu/runner pin:images
pnpm --filter @gotchu/runner build
pnpm --filter @gotchu/runner typecheck
pnpm --filter @gotchu/runner test
pnpm --filter @gotchu/runner exec node --input-type=module -e '
  import { selfTest } from "./dist/index.js";
  const result = await selfTest({ cacheDir: process.env.GOTCHU_RUNNER_CACHE_DIR });
  console.log(result);
  if (result.status !== "passed") process.exitCode = 1;
'
pnpm --filter @gotchu/runner test:vm
```

`GOTCHU_RUNNER_CACHE_DIR` overrides image preparation and the VM test source cache; it leaves the shared default cache untouched. Runtime APIs still take explicit `cacheDir` options: root must use that same private cache with `selfTest`, `checkRunnerGate` and `createFirecrackerRunner`. The exported default `runJob` uses the existing default cache. Image preparation alone does not open the gate. A fresh successful canary is bound to the newly built launcher/config and image digests for 15 minutes. The old 08:05 canary is expired and cannot be reused.

Only root should record the actual measured rootfs hash, commands/outcomes, fresh canary time and real selected base/candidate results. Confirm clean VM cleanup after every attempt. Unit event mocks and the authored VM test sources are not substitutes for these runs.

For the current Arena source correction, root chooses the unchanged multipart creator and accounts cases and an explicit filter excluding the Vite/assets-dependent case. The 337-file supported snapshot excludes HTML/assets; this is a declared compatibility limit, not evidence of full-suite success. Partial OSV coverage (200 of 226 versions) and unknown reachability are separate report facts and cannot become complete through selected functional tests.

References: [Node 24 test summary event](https://nodejs.org/docs/latest-v24.x/api/test.html#event-testsummary), [Node 24.22.1 file wrappers and child stdio](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/test_runner/runner.js), [Node count accounting](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/test_runner/utils.js), [tsx 4.23.15 metadata](https://registry.npmjs.org/tsx/4.23.15), [esbuild 0.28.2 metadata](https://registry.npmjs.org/esbuild/0.28.2).
