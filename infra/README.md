# Local runtime

The AWS deployment and GitHub CI/CD have been retired. See the [retirement record](aws/README.md). Development and self-hosting remain local.

Compose provides persistent local Postgres and Redis. `./gotchu up` runs web, coordinator, scanner, gateway and the investigation worker as loopback host processes. The scanner uses digest-pinned parser containers and loopback HTTPS. In `single_app` mode the independent executor also owns the GitHub broker, even with publication disabled; optional publication requires `GOTCHU_EXECUTOR_ENABLED=true`. The legacy Reader/Writer integration retains its private Writer App file, installation ID and operator catalog. Private GitHub credentials stay outside web in single-App mode. Candidate validation needs its separately configured runner. See [self-hosting](../docs/self-hosting.md) for exact setup and [development](../docs/development.md) for the development launcher.

Self-host uses a private `.gotchu/.env`, its own Compose project name, and the one-time Owner bootstrap described in [self-hosting](../docs/self-hosting.md). The legacy `infra-local-*` scripts continue using `infra/.env` by default.

The customer application is the product: authenticated workspaces, authorized source and HTTPS assessment, evidence-backed reports, and a usable interface. The fictional vulnerable/corrected application remains a regression fixture. Core assessment uses deterministic local checks and attributed advisory data, without a model or paid API.

## Start locally

```sh
./gotchu up
./gotchu status
./gotchu down
```

The installer stores its private environment and runtime credentials under `.gotchu/`. The lower-level `scripts/infra-local-*` commands use `infra/.env` for Compose boundary checks; they are not the app start path above. Compose's web, coordinator, and executor profiles remain separate packaging boundaries, while normal self-host setup starts only Postgres and Redis in Compose.

Both app profiles use the root Dockerfile. The build stages use Node 24.18.1, pnpm 11.21.0, and `pnpm install --frozen-lockfile`; runtime images contain production dependencies and compiled output only. The coordinator image also includes `@gotchu/assessment` compiled output, its production dependencies and offline advisory snapshot, plus `@gotchu/demo-target` compiled output, dependencies, and trusted fixture files at their workspace paths. Containers run as the invoking unprivileged UID/GID (1000:1000 by default) with a read-only root filesystem, a writable `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, and CPU, memory, and process limits.

The controlled demo is opt-in: `GOTCHU_DEMO_ENABLED` defaults to `false` for both web and coordinator. Set it to `true` in `infra/.env` to enable the fixed fictional target and assessment flow. When `GOTCHU_DEMO_TARGET_ORIGIN` is unset, the coordinator starts its own trusted target at `127.0.0.1:4100`; an operator may set an approved loopback/private target origin as an override. Compose never publishes port `4100`. The assessment reads only the bundled fixtures and offline advisory snapshot; it does not need a model, paid service, source repository, or external identity provider. Customer-code execution remains disabled.

| Service | Profile | Published address | Readiness gate |
| --- | --- | --- | --- |
| Web | host process | `127.0.0.1:3000` | Both runtime database logins must be ready. Private self-host bootstrap uses local credentials; external Auth.js providers are optional. Routes: `/api/health` and `/api/ready`. |
| Coordinator | host process | `127.0.0.1:3003` | Postgres, Redis, and at least one assigned organization. Routes: `/health/live` and `/health/ready`. |
| Scanner | host process | `127.0.0.1:4400` | Coordinator-authenticated HTTPS readiness and pinned scanner profiles. |
| Postgres | always on | `127.0.0.1:55432` | Persistent named volume; bootstrap credentials are not used by app containers. |
| Redis | always on | `127.0.0.1:56379` | Password protected, AOF enabled, persistent named volume. |
| Executor | opt-in host process | `127.0.0.1:3004` | Postgres/Redis leases and approvals, Writer App only in the executor, exact remote PR verification; readiness requires a configured Writer App. |

Private self-host setup creates the initial Owner through its one-use setup link and local password flow. Google, OIDC and GitHub sign-in are optional. Deterministic processing remains independent of model configuration. Repository publication requires explicit Owner consent and exact action approval from the authenticated session; the customer runtime does not require a second factor. The coordinator returns 503 while no organization is assigned.

The host app processes bind to loopback. The executor health and private verification routes are reachable only at `127.0.0.1`; web receives a separate random internal token but never receives the Writer App key. Never publish database, Redis, or executor ports beyond loopback, and do not attach the agent to either data network or mount the Docker socket.

## Network and deployment gates

Postgres and Redis use an internal Docker network plus loopback-only host ports. The app processes connect through those host ports. The installer does not start the Compose app profiles; those profiles remain available for separate packaging checks. Production needs a reviewed egress policy for whichever identity provider and provider-write adapters are configured.

Published app ports use plain HTTP on host loopback for local development. There is no public ingress or TLS-terminating proxy in this Compose stack. Outside local development, `PUBLIC_APP_URL` must be an HTTPS origin and an independently reviewed ingress must terminate TLS before the app is exposed. The current live check verifies outbound HTTPS reachability to its test endpoint; it does not prove OIDC callback/token exchange, public ingress TLS, organization authorization, or the exact approval lifecycle.

The Compose executor profile remains a fail-closed boundary; the installer starts the independent executor as a host process only after its setup checks pass. It receives the Writer App file path and its own database login; web receives only the shared loopback verification token. Repository write access requires explicit authenticated Owner-session consent after the executor verifies installation coverage. Supported customer suites use the separate gated validation runner; no customer code executes in web or coordinator.

## Checks and cleanup

```sh
scripts/infra-compose-validate.sh
scripts/infra-live-check.sh
scripts/infra-local-down.sh
```

After building the coordinator image, the focused packaging check accepts normalized Compose JSON on stdin and optionally an image name. It checks the opt-in/default and private-port policy, then runs both built-in assessment revisions from that image with networking disabled:

```sh
docker build --target coordinator -t gotchu-coordinator-check -f Dockerfile .
docker compose --profile '*' --env-file infra/.env -f infra/compose.yaml config --format json \
  | node scripts/infra-check.mjs gotchu-coordinator-check
```

The live check uses a unique Compose project, random loopback ports, mode-0600 temporary credentials, and isolated named volumes. It verifies persistent Postgres/Redis state, invokes database bootstrap twice to check role idempotency and safety, builds and probes the real web/coordinator images, and confirms the four gated profiles still exit 78. Its cleanup removes only that test project's containers, local images, volumes, and temporary credentials. Normal `infra-local-down.sh` retains the local persistent volumes.
