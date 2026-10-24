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

- Semgrep CE 1.182.0: local JS/TS patterns for `eval`, selected imported `child_process.exec` calls, disabled certificate verification, and a Helmet CSP candidate. The CSP candidate is accepted only when a fixed TypeScript 5.9.3 parser gate finds the exact Semgrep byte offset at a top-level expression or variable initializer, using one non-type-only default import from the literal `helmet` module and a one-property `{ contentSecurityPolicy: false }` object. It rejects parse errors, duplicate/spread/computed options, binding conflicts and mutations anywhere in the file, and calls inside nested function, class, block or control scopes. The parser uses only uploaded bytes, is bounded by the existing 1 MiB per-file limit, and caches one parse per matched file per assessment. Other Semgrep rules keep their existing normalization. Metrics/version checks, git ignores and inline suppression are disabled. An empty controlled `.semgrepignore` replaces default exclusions. Parse errors, omitted JS/TS files, or unsupported CSP candidates yield unknown Semgrep coverage. This is a bounded SAST profile, not whole-program reachability analysis.
- Gitleaks 8.28.0: three controlled rules for private-key markers, AWS access-key identifiers and literal secret assignments. Full CLI redaction; source excerpts and secret values are never retained in reports. Secret validity is unknown. Customer suppression/configuration cannot override the fixed profile.
- Trivy 0.67.2: Kubernetes configuration checks embedded in the pinned image. Rule updates and version checks are disabled; no remote rules, Helm rendering, Terraform execution, vulnerability DB download or customer configuration. Every uploaded YAML/JSON file is conservatively treated as a configuration candidate. A candidate absent from Trivy results (including malformed, unrecognized, or unrelated JSON such as package metadata) makes configuration coverage unknown while retaining available findings. No candidates and no recognized configuration is explicitly unsupported coverage.
- npm `package-lock.json` v2/v3: deterministic direct/transitive exact-version inventory. At most 200 entries are checked per run; links, ranges, unsupported entries and excess packages stay unknown. The optional OSV adapter makes at most two batches of 100 queries to `https://api.osv.dev/v1/querybatch`; only package names and versions leave the host. No source, tenant IDs, credentials or lockfile contents are sent. Each response is capped at 256 KiB with an eight-second deadline; redirects/compression are refused. Pagination stays unknown. Querybatch returns advisory IDs, not severity: reports explicitly mark severity unassessed and exploitability unknown.

Each profile records its image digest, tool version, controlled-rule checksum, source digest and bounded redacted evidence with SHA-256 checksums. Semgrep profile provenance also records the Helmet gate version and actual TypeScript parser version. The source CSP finding is a static configuration indication only: registration, execution, other CSP mechanisms, deployment, route association, causality and exploitability remain unknown; it does not raise the existing inferred confidence or medium Semgrep severity. At most 100 findings/200 evidence records per analysis and 1 MiB per report; omissions make coverage partial. Source/deployment equivalence and absence in the other analysis are unverified. Package/advisory matches and banners never prove exploitation or compromise.

## Trusted local scanner host

The supervisor needs Docker CLI access to the local Unix daemon. It has no database/Redis dependency. Images are fixed in `src/docker.ts`; pull them as an operator before readiness, never during a job:

```sh
docker pull semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af
docker pull zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854
docker pull aquasec/trivy@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08
```

Every job has a private temporary parent directory, validated files mounted read-only, a fixed read-only profile, nonroot UID, no network, no capabilities, no-new-privileges, read-only root, 128-process limit, one CPU, 30-second CPU limit, 768 MiB memory/no extra swap, 128 MiB noexec tmpfs, 1 MiB combined stdout/stderr bound and 35-second wall deadline. Docker daemon logging is disabled. The service credential is absent from the CLI environment and scanner containers. No Docker socket is mounted into a scanner. No shell interpolates customer text. Finally blocks remove the exact named container and directory; cleanup failure fails the job and latches the adapter and runner unready. The engine promise retains ownership until every started operation, including cleanup, settles, even after cancellation. A hung adapter cannot release capacity by reaching its deadline. Cleanup faults never become partial-success reports. Failed container removal retains its private directory for reconciliation; the operator must confirm removal of the affected containers/directories before restarting the supervisor. There is no automatic fault reset. These are parser sandboxes, not demonstrated VM isolation; customer-code execution remains prohibited.

Readiness actually runs the pinned profiles against known self-test bytes and requires real matching output; image existence alone is insufficient. Results cache for 30 seconds and process failures invalidate the cache. Aggregate readiness also coalesces and caches the advisory check for 30 seconds. The OSV adapter readiness checks an actual bounded query when enabled. Missing/broken tools return unready and unavailable coverage.

## Public HTTPS transport

The default `root` scan profile, including older durable requests with no profile field, makes one GET `/` at the persisted canonical HTTPS origin, port 443 only. The separately consented `public_surface` profile keeps that same target origin and makes a fixed, bounded set of serial GETs: `/`, `/.well-known/security.txt`, `/security.txt`, `/robots.txt`, `/sitemap.xml`, then uses any remaining slots up to ten total for same-origin links extracted from bounded HTML anchors and sitemap locations. It also follows same-origin `Sitemap:` entries from `robots.txt`. Paths with a query or fragment, traversal, a different host/scheme/port, or unsafe URL syntax are ignored. Neither profile follows redirects, sends credentials/cookies, retries, enumerates subdomains or exploits the target.

Both profiles resolve all DNS addresses afresh for every request and reject any nonpublic, mapped, metadata, multicast, reserved or documentation address. A selected validated IP is pinned to the socket; TLS verifies the certificate chain and original hostname with SNI. The deadline for each request is the earlier of five seconds or the target authorization expiry. Authorization is checked again immediately after DNS before any connection; a delayed DNS answer cannot authorize a late GET. Each response has an 8 KiB raw header limit and 16 KiB streaming body limit. The `public_surface` profile also limits the full run to 64 KiB of response bodies and waits 250 ms between requests. Bodies/cookies/location headers are discarded from report evidence. Missing headers are observations for that response; banners are unverified indications, never inventory.

The exported `createPublicSurfaceProbe` requires a validated target with `scanProfile: 'public_surface'`; it returns a typed inventory of the exact verified origin and requested entrypoints. The runner selects it only when that explicit persisted profile is present. Missing/`root` profile values stay on the one-request legacy path. The report records response summaries and coverage in the existing report schema. Hitting a cap or losing transport preserves completed responses and marks the remaining coverage unknown. This profile is not a company-wide asset inventory: JavaScript-generated, authenticated, query-based, subdomain, non-HTTPS and alternate-port entrypoints remain outside coverage.

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

The maintained Semgrep 1.182.0 profile is digest-pinned and has passed local Linux/amd64 Docker validation, including a `NODE_ENV=production` TLS scanner-to-coordinator run that persisted a tenant-bound, source-bound report and delivered its outbox record. Gitleaks, Trivy, and OSV were exercised against the documented bounded profiles. This evidence does not establish broad scanner accuracy, all-architecture behavior, AWS deployment, VM isolation, general route scanning, installed inventory, exploitability proof, or production capacity. No customer code is executed.

Official references consulted: [Semgrep CLI](https://docs.semgrep.dev/cli-reference), [Semgrep Docker images](https://hub.docker.com/r/semgrep/semgrep), [Gitleaks configuration and redaction](https://github.com/gitleaks/gitleaks), [Trivy config CLI](https://trivy.dev/docs/latest/references/configuration/cli/trivy_config/), [OSV batch API](https://google.github.io/osv.dev/post-v1-querybatch/).

Source assessment remains intentionally bounded to uploaded JS/TS, JSON, YAML, and TOML files. Dependency inventory supports npm `package-lock.json` v2/v3 only, checks at most 200 entries, and leaves unsupported manifests, package formats, excess entries, and unrecognized configuration coverage unknown. The scanner's standalone production TLS configuration and coordinator-scoped CA trust are documented in [the scanner service guide](../../apps/scanner/README.md). Local production TLS and source-report checks passed for the exercised Linux/amd64 paths; representative accuracy and capacity validation remain open. See the [verification record](../../docs/validation.md) for evidence and limits.
