# Customer assessment engine (development)

`createCustomerAssessmentRunner(options?).run(input: CustomerRunInput): Promise<CustomerAssessmentReport>` accepts the exact version 2 `@gotchu/contracts` input returned by `backend.customers.getRequest(claim)`. It assesses uploaded customer files and/or the independently verified public HTTPS origin. There is no demo target, fixed repository or revision enum. Reports bind organization, application, job, source ID/digest and target ID/version/origin. Persist through `backend.customers.recordResult` to recheck the lease and current authorization.

```ts
import { createCustomerAssessmentRunner, createOsvAdapter } from '@gotchu/customer-assessment';
const runner = createCustomerAssessmentRunner({ advisory: createOsvAdapter() });
const readiness = await runner.readiness();
const report = await runner.run(persistedInput);
```

`CustomerAssessmentOptions` accepts optional trusted `scanners: ScannerAdapter`, `advisory: AdvisoryAdapter`, `https: HttpsOptions`, and `deadlineMs` (1–55,000; default 55,000). These are operator/test adapters, never HTTP input. Omitting the advisory adapter makes advisory coverage unavailable and readiness unready; deterministic source/HTTPS checks still run. Source and external branches run independently. External-only needs no repository, source, scanner image or advisory API.

## Profiles and evidence

Source bounds derive from the shared contract: 4 MiB serialized snapshot, 1,000 files and 1 MiB per file. The runner verifies the canonical source digest used by the backend (sorted object keys, ordered files). It never installs packages, imports customer modules, runs scripts/tests/build tools, or executes customer code.

- Semgrep CE 1.90.0: three local JS/TS patterns for `eval`, selected imported `child_process.exec` calls, and literal disabled certificate verification. Metrics/version checks, git ignores and inline suppression are disabled. An empty controlled `.semgrepignore` replaces default exclusions. Parse errors or omitted JS/TS files yield unknown coverage. This is a bounded SAST profile, not whole-program reachability analysis.
- Gitleaks 8.28.0: three controlled rules for private-key markers, AWS access-key identifiers and literal secret assignments. Full CLI redaction; source excerpts and secret values are never retained in reports. Secret validity is unknown. Customer suppression/configuration cannot override the fixed profile.
- Trivy 0.67.2: Kubernetes configuration checks embedded in the pinned image. Rule updates and version checks are disabled; no remote rules, Helm rendering, Terraform execution, vulnerability DB download or customer configuration. No recognized configuration is explicitly unsupported coverage.
- npm `package-lock.json` v2/v3: deterministic direct/transitive exact-version inventory. At most 200 entries are checked per run; links, ranges, unsupported entries and excess packages stay unknown. The optional OSV adapter makes at most two batches of 100 queries to `https://api.osv.dev/v1/querybatch`; only package names and versions leave the host. No source, tenant IDs, credentials or lockfile contents are sent. Each response is capped at 256 KiB with an eight-second deadline; redirects/compression are refused. Pagination stays unknown. Querybatch returns advisory IDs, not severity: reports explicitly mark severity unassessed and exploitability unknown.

Each profile records its image digest, tool version, controlled-rule checksum, source digest and bounded redacted evidence with SHA-256 checksums. At most 100 findings/200 evidence records per analysis and 1 MiB per report; omissions make coverage partial. Source/deployment equivalence and absence in the other analysis are unverified. Package/advisory matches and banners never prove exploitation or compromise.

## Trusted local scanner host

The supervisor needs Docker CLI access to the local Unix daemon. It has no database/Redis dependency. Images are fixed in `src/docker.ts`; pull them as an operator before readiness, never during a job:

```sh
docker pull semgrep/semgrep@sha256:7b625711ba9b6d1a543e308967b18c01b59932490a5536a06422666474bf6ee4
docker pull zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854
docker pull aquasec/trivy@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08
```

Every job has a private temporary parent directory, validated files mounted read-only, a fixed read-only profile, nonroot UID, no network, no capabilities, no-new-privileges, read-only root, 128-process limit, one CPU, 30-second CPU limit, 768 MiB memory/no extra swap, 128 MiB noexec tmpfs, 1 MiB combined stdout/stderr bound and 35-second wall deadline. Docker daemon logging is disabled. The service credential is absent from the CLI environment and scanner containers. No Docker socket is mounted into a scanner. No shell interpolates customer text. Finally blocks remove the exact named container and directory; cleanup failure fails the job. These are parser sandboxes, not demonstrated VM isolation; customer-code execution remains prohibited.

Readiness actually runs the pinned profiles against known self-test bytes and requires real matching output; image existence alone is insufficient. Results cache for 30 seconds and process failures invalidate the cache. The OSV adapter readiness checks an actual bounded query when enabled. Missing/broken tools return unready and unavailable coverage.

## Public HTTPS transport

One GET `/` at the persisted canonical HTTPS origin, port 443 only. Each operation resolves all DNS addresses afresh and rejects any nonpublic, mapped, metadata, multicast, reserved or documentation address. A selected validated IP is pinned to the socket; TLS verifies the certificate chain and original hostname with SNI. No environment proxy, credentials, cookies, redirects, retry, endpoint enumeration or exploitation. Five-second total deadline, 8 KiB raw header limit, 16 KiB streaming body limit. Bodies/cookies/location headers are discarded. Missing headers are observations for that response; banners are unverified indications, never inventory.

`HttpsOptions.testFixture` is accepted only with `NODE_ENV=test`, an injected lookup, an exact fixture hostname, a nonprivileged explicit port and a supplied test CA. Only that fixture can use literal loopback answers. It cannot grant production private-network access. DNS/TLS/body/header failures remain unknown.

## Verification and limits

After the parent integrates version 2 contracts and reconciles the shared lockfile:

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/customer-assessment build
pnpm --filter @gotchu/customer-assessment typecheck
pnpm --filter @gotchu/customer-assessment test
pnpm --filter @gotchu/customer-assessment test:live
```

Unit tests include explicitly injected unavailable scanners/advisory fixtures. HTTPS tests use real sockets and a temporary self-signed certificate generated with OpenSSL, scoped to the test hostname/port. `test:live` requires Docker and outbound OSV access and fails if unavailable; it executes all three pinned scanners and the live advisory query. It does not silently skip or manufacture findings.

Validated locally: all three actual Docker profiles, real OSV known-vulnerable/fixed-version lookup, real TLS fixtures, source limits, digest binding, deadline/unavailable semantics and report validation. Semgrep 1.143.0 could not be extracted because this host ran out of disk; the smaller official pinned 1.90.0 image was tested instead. Updating that pin and representative scanner accuracy/performance testing remain maintenance gates. No AWS deployment, VM isolation, general route scanning, installed inventory, exploitability proof or production capacity claim.

Official references consulted: [Semgrep CLI](https://docs.semgrep.dev/cli-reference), [Semgrep Docker images](https://hub.docker.com/r/semgrep/semgrep), [Gitleaks configuration and redaction](https://github.com/gitleaks/gitleaks), [Trivy config CLI](https://trivy.dev/docs/latest/references/configuration/cli/trivy_config/), [OSV batch API](https://google.github.io/osv.dev/post-v1-querybatch/).
