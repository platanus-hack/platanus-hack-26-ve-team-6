# Local customer application

The local development starter runs the authenticated Gotchu customer app, coordinator, and scanner against persistent local PostgreSQL and Redis. It does not enable the fictional assessment fixture, seed a principal or workspace, or need an OAuth or model provider.

The root package provides:

```sh
pnpm dev:start
pnpm dev:stop
pnpm dev:prepare # only when a pinned image is missing
```

`dev:start` creates `infra/.env` with `scripts/infra-local-setup.sh` only when that file is absent. The setup script creates private local credentials and never overwrites an existing file. Startup compiles the built assets with `NODE_ENV=production` while running the local services with `NODE_ENV=development`. This keeps the React JSX runtime consistent and enables only the explicit development registration settings. It builds only the coordinator and web workspace graphs; the scanner and customer-assessment engine are included through the coordinator dependency graph. It then calls `scripts/infra-local-up.sh`, which applies migrations and provisions the restricted runtime database roles while retaining persistent data volumes.

The three Node services bind to literal loopback addresses. Open the web app at `http://localhost:3000`; coordinator and scanner listen at `127.0.0.1:3003` and `127.0.0.1:4400`. Set trusted `GOTCHU_DEV_WEB_PORT`, `GOTCHU_DEV_COORDINATOR_PORT`, or `GOTCHU_DEV_SCANNER_PORT` values to choose other distinct ports. The web service uses the API and ingestion database roles, the coordinator uses its own database role and Redis, and the scanner receives only its port, raw secret-file path, and scanner settings. Child process environments are built from an explicit allowlist and do not inherit operator database URLs or provider credentials.

The starter generates one 32-byte scanner secret in `.local/dev/scanner.secret` and reuses it on later starts. Process IDs, Linux start times, ports, and log paths are recorded in `.local/dev/state.json`. The directory, state, secret, and service logs are private. `dev:stop` sends `SIGTERM` only to recorded processes whose PID, start time, owner, and command still match; it waits up to 15 seconds and reports any process that is still draining. It retains PostgreSQL and Redis data. Run `scripts/infra-local-down.sh` separately to stop those data services while retaining their volumes.

Local Auth.js credentials are enabled, including local registration for creating a real user and workspace. Use a long development password and keep this loopback service local. The customer-discovery coordinator finds new customer workspaces automatically; its configured organization list starts empty. `GOTCHU_DEMO_ENABLED` is not passed to either app, so the demo API and fixed fixture remain disabled.

Before starting services, the script inspects the exact image references exported by `@gotchu/customer-assessment` and the PostgreSQL and Redis references from Compose. The scanner must pass `/readyz` using actual Semgrep, Gitleaks, Trivy, and OSV metadata-only checks before startup reports ready. The first check can take up to 90 seconds; it never treats missing images or tools as ready. `GOTCHU_SCANNER_OSV=1` enables the bounded free OSV query for exact package names and versions; source contents and customer credentials are not sent to that service.

Deterministic source/HTTPS assessments do not need a model key. Keep `LANGSMITH_TRACING`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2`, and `LANGCHAIN_VERBOSE` disabled for customer scans. If tracing or verbosity is enabled, scanner readiness and each run fail closed before input or adapter work so private source is not sent to tracing callbacks. The optional model-investigation path is separate and reports unavailable when it is not configured.

If a pinned image is missing, startup stops before launching the Node services and names the missing image. `dev:prepare` builds the small profile package and checks Docker storage before pulling only missing pinned scanner and data-service images. It requires at least 5 GiB free in Docker storage before beginning any pull. With less free space, it pulls nothing and asks you to free space first. The scanner profile pins Semgrep 1.90.0 and is enforced as development/test-only; scanner production readiness is not established.

An authorized `public_surface` assessment stays on the consented origin and makes at most ten serial GETs, reading up to 64 KiB total and 16 KiB per response. It discovers safe same-origin links from HTML, robots, and sitemap responses without JavaScript execution. It may GET safe discovered same-origin public paths; it performs no authenticated or state-changing API exercise or API introspection. It does not inspect subdomains or follow redirects. Only complete TLS responses support path-specific CSP, HSTS, and nosniff observations; these do not prove software identity or exploitation.

Useful local locations:

- `.local/dev/state.json` — tracked processes, ports, and log paths.
- `.local/dev/web.log`, `.local/dev/coordinator.log`, `.local/dev/scanner.log` — private service logs.
- `.local/dev/scanner.secret` — raw 32-byte shared scanner credential; do not copy or commit it.
- `infra/.env` — private local infrastructure and Auth.js credentials.

## Monitoring configuration

The launcher enables the persisted monitoring scheduler and metadata-only OSV repository checks. To expose allowed repositories in **Vigilancia**, set an operator-managed `GOTCHU_MONITORING_CONFIG_FILE` before startup; the launcher passes that path to the web and coordinator. The catalog reloads per operation and binds each entry to its exact workspace/application. No model or GitHub account is mandatory; local managed bare Git repositories are supported. See [operational setup](operations.md).

Signed telemetry credentials are stored as private local files under `.local/dev/event-credentials`. The dashboard shows a new key once; the trusted application server uses it through `@gotchu/sdk`. This development store is not an encrypted hosted credential service. Disabling/rotating the integration stops acceptance under the old persisted key. Runtime telemetry and periodic source/HTTPS monitoring expose independent coverage.

Runtime metric windows are fixed at ten minutes and retain the first immutable metrics snapshot. Later event batches rerun detectors against the expanded window. This is not a continuously refreshed same-window metric or a recovery measurement.
