# Local Compose runtime

Compose provides persistent local Postgres and Redis by default. The `web` and `coordinator` profiles build and run the real Node applications; `gateway`, `agent` (`apps/worker`), `executor`, and `scanner` remain explicit exit-78 boundaries until their provider, TLS, and VM isolation gates pass.

## Start locally

```sh
scripts/infra-local-setup.sh
scripts/infra-compose-validate.sh
scripts/infra-local-up.sh
docker compose -p "gotchu-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')" \
  --env-file infra/.env -f infra/compose.yaml \
  --profile web --profile coordinator up -d --build web coordinator
```

The setup script creates `infra/.env` with mode `0600`. It contains local database passwords and `AUTH_SECRET`; it does not create GitHub OAuth credentials, organization assignments, an event-signing key, or a worker signing key. `GOTCHU_EVENT_SIGNING_KEYS_JSON` is an optional web-only local credential-map adapter, with JSON keys mapped to base64-encoded signing keys. It is empty by default and is not production secret custody. Keep this file local. The root `.dockerignore` excludes it and other environment files from image build contexts.

Both app profiles use the root Dockerfile. The build stages use Node 24.18.1, pnpm 11.21.0, and `pnpm install --frozen-lockfile`; runtime images contain production dependencies and compiled output only. Containers run as UID/GID 1000 with a read-only root filesystem, a writable `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, and CPU, memory, and process limits.

| Service | Profile | Published address | Readiness gate |
| --- | --- | --- | --- |
| Web | `web` | `127.0.0.1:3000` | Both runtime database logins and GitHub OAuth must be ready. Routes: `/api/health` and `/api/ready`. |
| Coordinator | `coordinator` | `127.0.0.1:3003` | Postgres, Redis, and at least one assigned organization. Routes: `/health/live` and `/health/ready`. |
| Postgres | always on | `127.0.0.1:55432` | Persistent named volume; bootstrap credentials are not used by app containers. |
| Redis | always on | `127.0.0.1:56379` | Password protected, AOF enabled, persistent named volume. |

Missing `AUTH_GITHUB_ID` or `AUTH_GITHUB_SECRET` leaves sign-in unconfigured and `/api/ready` returns 503. Fresh second-factor approval remains explicitly unavailable in the web readiness capability data, while the endpoint's ready status follows its existing database and Auth.js contract. The coordinator returns 503 while no organization is assigned. Investigator availability is reported separately: deterministic queue processing can be ready without a model worker, and investigation jobs remain visibly unavailable until one is configured.

The coordinator reads `GOTCHU_COORDINATOR_HOST` for its bind address. Its container sets this to `0.0.0.0` so Docker can publish the listener; it does not use the unrelated `HOST` variable. Never publish the database or Redis ports beyond loopback, and do not attach the agent to either data network or mount the Docker socket.

## Network and deployment gates

Postgres, Redis, and app-to-data traffic use the internal `data` network. The local database and coordinator publishing bridges disable inter-container communication and outbound masquerading. Coordinator also joins that host-only bridge so its loopback-published port is reachable while its control-plane, data, and agent links stay internal. Gateway, executor, agent, and scanner stay on internal networks. Only web joins `web-egress`, a normal Docker bridge, so the GitHub OAuth authorization/token flow can reach GitHub. This grants broad outbound connectivity; Compose does not enforce destination allowlists or a DNS policy. Production needs a reviewed egress policy for GitHub endpoints and verification of outbound TLS before enabling OAuth.

Published app ports use plain HTTP on host loopback for local development. There is no public ingress or TLS-terminating proxy in this Compose stack. Outside local development, `PUBLIC_APP_URL` must be an HTTPS origin and an independently reviewed ingress must terminate TLS before the app is exposed. The live check verifies GitHub HTTPS reachability, but does not prove OAuth callback/token exchange, public ingress TLS, organization authorization, or fresh-MFA behavior.

The isolated agent profile receives no database, Redis, provider credential, signing key, host path, or Docker socket. Gateway, executor, and scanner profiles stay disabled; the executor has no provider write integration, and customer-code execution remains disabled until a disposable VM-class boundary is demonstrated. Compose container hardening is not a substitute for that boundary.

## Checks and cleanup

```sh
scripts/infra-compose-validate.sh
scripts/infra-live-check.sh
scripts/infra-local-down.sh
```

The live check uses a unique Compose project, random loopback ports, mode-0600 temporary credentials, and isolated named volumes. It verifies persistent Postgres/Redis state, invokes database bootstrap twice to check role idempotency and safety, builds and probes the real web/coordinator images, and confirms the four gated profiles still exit 78. Its cleanup removes only that test project's containers, local images, volumes, and temporary credentials. Normal `infra-local-down.sh` retains the local persistent volumes.
