# @gotchu/monitoring

Read-only adapters for scheduled monitoring runs. This package does not schedule jobs, persist observations, send repository contents to a model, run customer code, install dependencies, or write to customer providers. The backend owns tenant authorization, monitor claims, durable evidence, and observation recording.

## Operator repository registry

The trusted operator configuration maps an opaque repositoryKey to a provider and an explicit organization/application scope. HTTP callers select a key; they never provide repository URLs, local paths, refs, or credentials.

parseMonitoringProviderConfig validates the registry and createMonitoringRepositoryCatalog exposes. loadMonitoringRepositoryCatalog(configFile) reads a regular, non-symlink JSON file up to 512 KiB and returns a fresh catalog. The caller passes the config path explicitly and can reload per request or watch; this package does not read environment variables or cache config.

- listAllowedRepositoryOptions({ organizationId, applicationId }) for a tenant-filtered API response that contains no local paths or token file names.
- resolve(scope, repositoryKey) for an exact organization/application-scoped lookup.
- repositoryPath(entry) for backend-only local Git use under repositoryRoot.

Local Git entries name a normalized path to an operator-provisioned bare repository beneath the managed root. The reader resolves an exact configured ref to a commit SHA, reads its tree and supported blobs with fixed git commands, and compares the exact previous commit tree when supplied. It rejects symlinked repository paths, external object alternates, worktree repositories, unexpected local Git configuration, path escapes, Git symlinks and submodules. It uses a temporary working directory, a reduced environment, no shell, bounded command output, a command deadline, and no checkout or hook execution.

GitHub entries accept an owner, repository, optional configured ref, and an optional absolute token file path. Requests use only https://api.github.com, the fixed GitHub API version header, a pinned resolved commit SHA for tree/blob reads, bounded body sizes, safe pagination, short retries for transient GET failures, and an overall deadline. A private repository without a valid token is an unavailable source; the reader never claims a successful private connection without credentials. Tokens must be regular non-symlink files with owner-only permissions and are sent only in the Authorization header.

Both repository readers return a validated CustomerSourceSnapshot, the exact commit SHA, a canonical source digest compatible with customer snapshot storage, a bounded changed-path diff against the supplied previous SHA, and coverage limitations for excluded file types, symlinks, submodules, or capped history. The shared customer snapshot contract remains the boundary: up to 1,000 source files and 4 MiB serialized, with its JS/TS, JSON, YAML, and TOML path restrictions. Content is metadata for later server-side assessment and is never submitted to a model here.

## Dependency metadata

createOsvDependencyAdapter reads npm package-lock.json metadata from the exact snapshot and queries only package names and exact versions at the public OSV API. It follows bounded per-package next_page_token pagination, hydrates a bounded number of advisory records for summary, dates, aliases, references, and database severity, and returns separate repository-lockfile and advisory-database evidence. The output never claims that a package is installed, used at runtime, reachable, deployed, or exploited. Unsupported lockfiles, malformed metadata, package caps, and incomplete OSV pagination remain explicit coverage limitations.

dependency_advisory evidence needs the operation contract's advisory_database evidence source in addition to repository; adapters deliberately do not relabel OSV data as a provider status feed.

## Provider status and authorized target health

STATUS_PROVIDER_CATALOG lists Cloudflare and Railway as independent selectable public status watches. parseProviderStatusSelection accepts either or both without inferring customer impact. Cloudflare reads the official summary API. Railway reads the current JSON route used by its first-party status page (/api/status), rather than assuming the older Atlassian Statuspage response shape. Fresh publication time and the raw response checksum are retained in evidence. An upstream issue becomes an upstream_outage candidate with upstreamImpact: unverified. A current healthy feed returns a coverage_check candidate; an old feed or missing Railway component-day becomes a coverage_gap candidate. These describe feed coverage only, never customer application health.

createAuthorizedHttpsHealthAdapter wraps the existing customer-assessment HTTPS probe. It accepts only a trusted CustomerRunInput.target supplied by the backend after persisted authorization checks. The probe uses the existing public DNS checks, TLS verification, five-second deadline, one GET to /, no redirect following, and no customer cookies or credentials. It does not bypass the target authority or accept an HTTP-supplied origin. A successful response is a coverage_check, a 4xx or incomplete probe is a coverage_gap, and a 5xx is a public_surface observation; none by itself establishes duration or cause.

## Backend handoff

Adapters return MonitoringCandidate values with kind, summary, severity, confidence, observation/freshness timestamps, and evidence fields (source, reference, SHA-256 checksum, collectedAt, adapter, and adapterVersion). They do not add tenant scope, basis, runId, leaseToken, or idempotency keys. The coordinator must bind candidates to the current MonitorWork claim before calling recordObservation. Repository changes and advisory metadata are observations, not proof of deployment or exploitation.

The integrated scheduler uses canonical customer audit jobs for HTTPS checks, including their target revocation/quarantine fence. It projects their persisted reports using assessment-basis evidence. The standalone authorized HTTPS health helper is not used to bypass that workflow; its raw response-summary evidence is not accepted as monitor-basis assessment evidence by the backend.

## Source references

- [Customer snapshot limits and validation](../contracts/src/customer-assessment.ts)
- [Existing public HTTPS assessment transport](../customer-assessment/src/https.ts)
- [Cloudflare status API documentation](https://www.cloudflarestatus.com/api)
- [Cloudflare status programmatic access](https://developers.cloudflare.com/support/cloudflare-status/)
- [Railway status page](https://status.railway.com/)
- [Railway deployment troubleshooting](https://docs.railway.com/deployments/troubleshooting/slow-deployments)
- [GitHub REST commit endpoints](https://docs.github.com/en/rest/commits/commits)
- [GitHub REST Git tree endpoint](https://docs.github.com/en/rest/git/trees)
- [GitHub REST Git blob endpoint](https://docs.github.com/en/rest/git/blobs)
- [OSV batch query API](https://google.github.io/osv.dev/post-v1-querybatch/)
- [OSV vulnerability lookup API](https://google.github.io/osv.dev/post-v1-vulns/)

The tests use real temporary local Git repositories and explicit HTTP/TLS fixtures. They are adapter contract tests, not live GitHub, OSV, Cloudflare, or Railway availability guarantees.
