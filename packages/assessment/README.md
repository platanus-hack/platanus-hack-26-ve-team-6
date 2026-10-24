# Controlled assessment runner

Integration contract:

```ts
import { createControlledAssessmentRunner } from '@gotchu/assessment';

const runner = createControlledAssessmentRunner({
  // Operator configuration only; never copy an HTTP request field here.
  origin: 'http://127.0.0.1:4100',
});
const report = await runner.run({
  organizationId, applicationId, jobId,
  targetKey: 'controlled-demo-store',
  mode: 'both', // internal | external | both
  revision: 'vulnerable', // vulnerable | corrected
});
```

The input and returned `AssessmentReport` use the exact `@gotchu/contracts` schemas. The backend must authorize the job and tenant before calling this trusted coordinator port. The runner preserves all three scope IDs. It performs observations only and returns no actions. A coordinator can supply this object directly as its `assessmentRunner` dependency.

`createControlledAssessmentRunner(options?)` returns `{ run(input: AssessmentRunInput): Promise<AssessmentReport> }`. Options are `origin?: string`, `repository?: ControlledRepositoryPort`, `timeoutMs?: number`, and `maxBodyBytes?: number`. The registry contains only `controlled-demo-store`, with one GET to `/vulnerable` or `/corrected`. No caller URL, path, redirect, credential, DNS name, or arbitrary port is accepted through run input. Operator origins must be literal loopback or RFC1918 IPv4 addresses; HTTP is supported only for this controlled local/private fixture. Defaults: `http://127.0.0.1:4100`, 2 seconds, 2 KiB response body. Operator limits may only be lowered.

`ControlledRepositoryPort.readFile(revision, path): Promise<Uint8Array>` accepts the fixed file names `store.ts`, `settings.json`, and `package.json`. The default adapter reads `apps/demo-target/src/fixtures` from the workspace layout, with a 16 KiB file limit and symlink/non-file rejection. This is a trusted fixture adapter, not a sandbox for arbitrary customer checkouts. External mode never calls or constructs that adapter and does not require fixture files to exist. Source files are read as data; assessment never imports them, installs their dependencies, or runs their scripts/tests. Only the trusted demo server imports its own compiled catalog rendering function.

Each of three repository reads has a two-second deadline; reading the two advisory files has one additional two-second deadline. The HTTP check has an independent two-second total deadline, including the body. Source and HTTP checks run independently and concurrently. The profile's I/O wait budget is at most eight seconds, below the coordinator's 60-second job lease. A replacement repository port owns cancellation of its own I/O; the runner stops awaiting it at the deadline and handles late rejection. This is a configured bound, not a measured production latency guarantee.

From the workspace root, after the parent reconciles the workspace lockfile:

```sh
pnpm install --frozen-lockfile
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/demo-target build
pnpm --filter @gotchu/assessment build
pnpm --filter @gotchu/demo-target start
# In another terminal; emits a complete JSON report to stdout:
pnpm --filter @gotchu/assessment assess --mode both --revision vulnerable
pnpm --filter @gotchu/assessment assess --mode both --revision corrected
pnpm --filter @gotchu/assessment assess --mode external --revision vulnerable
```

`GOTCHU_DEMO_TARGET_ORIGIN` configures the CLI operator origin. The CLI supplies fresh local-only scope IDs unless `--organization-id`, `--application-id`, and `--job-id` are provided. There is no URL or path run argument. CLI exit code 0 means the requested bounded profiles completed; exit code 2 means partial/unavailable coverage, not a passing security assessment. Run `pnpm --filter @gotchu/assessment test` for real loopback HTTP and repository boundary tests.

## Coverage and interpretation

This deliberately narrow profile checks explicit source literals with TypeScript's parser, response-header configuration, one captured advisory against an exact manifest version, and live response headers. Semgrep, OSV-Scanner, Gitleaks, Trivy, authentication testing, exploitation, cloud inspection, transitive dependency resolution, and customer-code execution are unsupported.

- **Shared observation:** missing CSP in the vulnerable configuration and the independently fetched vulnerable catalog response. A missing header is a low-severity hardening indicator, not proof of injection or compromise. Policy presence on the corrected route is checked; browser enforcement and policy quality are not tested.
- **Internal-only observations:** an exported audit-email boolean is true, and the declared lodash version matches the one captured advisory. The audit formatter is not called by the HTTP route. The manifest dependency is not installed or used by the target. Neither observation proves reachability or exploitability.
- **External-only indication:** the HTTP server adds a fictional `PaperMoon-Edge/1.0` banner outside the three inspected source/configuration/manifest files. Header text is observed, while the technology inference is marked inferred. It is not used to invent a dependency finding.
- **Corrected revision:** CSP is present, the audit-email boolean is false, and the unused lodash declaration is removed. The informational banner remains. These are measured differences on this profile, not a whole-application safety claim.

Correlations group only identical rule keys within the same report scope and selected revision. Both analyses retain separate findings and evidence. A missing or partial opposite analysis produces `unverified`, not an absence conclusion. `internal_only`/`external_only` mean only one profile observed the item; their explanations retain the other profile's coverage limitations. Every finding is referenced exactly once, checked by the public report schema. No finding claims demonstrated exploitation.

## Evidence and offline advisory provenance

Each evidence record has a real SHA-256 digest and a `sha256:<digest>` content reference. Source/configuration/manifest/advisory digests hash the exact read bytes. Excerpts are UTF-8 prefixes capped at 4096 characters; the advisory's full 4272-byte capture is retained in this package. A prefix checksum is not the full-file checksum. The analysis snapshot hashes UTF-8 `JSON.stringify(evidence.map(({ locator, checksum }) => ({ locator, checksum })))` in evidence order. A snapshot reference is a content identifier, not an external artifact-store URL.

HTTP evidence hashes UTF-8 `JSON.stringify(capture)`, with the complete bounded capture in the excerpt: URL, method, status, selected header names and base64 values, base64 body bytes, completion flag, and any transport failure. This is not a hash of raw wire framing or every header. Only CSP, content type and the technology banner are retained; cookies and unrelated headers are omitted. Header totals, duplicated selected headers, compression, redirects, non-200/non-HTML responses, timeouts and body limits are handled explicitly. Partial captures do not produce catalog findings.

The raw [GHSA-35jh-r3h4-6jhm capture](advisories/GHSA-35jh-r3h4-6jhm.json) is distributed with [provenance](advisories/provenance.json) and its [CC BY 4.0 license](advisories/LICENSE.md), attributed to GitHub Advisory Database contributors. It was retrieved on 2026-10-24 from [database commit 95c6886](https://github.com/github/advisory-database/blob/95c688698ee6767a611e157d7329d11f3e0a1f4b/advisories/github-reviewed/2021/05/GHSA-35jh-r3h4-6jhm/GHSA-35jh-r3h4-6jhm.json), whose record was last modified 2025-08-12. Its SHA-256 is `3060fadb9a686e5041d53fe5c20c7844b2a0a49ce8d7b3d89d70703be02ec4f1`; the runner verifies it before using the range. The [upstream lodash fix](https://github.com/lodash/lodash/commit/3469357cff396a26c363f8c1b5a91dde28ba4b1c) confirms the template-option issue.

The recorded npm lodash range is `<4.17.21`. This implementation only compares exact stable three-component versions to that range. Ranges, tags, aliases, prereleases, other packages, other advisories, installed versions, and transitive dependencies are unknown. High is this advisory's published severity, not demonstrated application impact. The offline snapshot is not refreshed at run time. In particular, `4.17.21` is the captured fix for this historical advisory, not a recommendation or assertion that it is currently safe. The corrected fixture removes the unused declaration. Assessment needs no GitHub account, network advisory service, model, cloud or paid API.
