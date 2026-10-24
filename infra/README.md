# Local runtime and AWS pilot foundation

Compose provides persistent local Postgres and Redis by default. `./gotchu up` builds and runs the `web` and `coordinator` profiles; the bounded scanner service runs as a host process so it can call Docker with host-visible temporary source paths. The coordinator reaches it through Docker's host gateway over HTTPS with a locally generated certificate trusted only for that scanner client. `gateway`, `agent` (`apps/worker`), and `executor` remain unavailable boundaries until their provider and VM isolation gates pass. For the existing development launcher, see [development](../docs/development.md).

Self-host uses a private `.gotchu/.env`, its own Compose project name, and the one-time Owner bootstrap described in [self-hosting](../docs/self-hosting.md). The legacy `infra-local-*` scripts continue using `infra/.env` by default.

The first product deliverable is a controlled demonstration assessed internally and externally, with evidence-backed comparison reports. Core assessment uses deterministic local checks and an attributed advisory snapshot, without a model or paid API. Live monitoring, approval, limited automation, and provider recovery are later stages. See the [AWS deployment and release gates](deployment.md).

## Start locally

```sh
scripts/infra-local-setup.sh
scripts/infra-compose-validate.sh
scripts/infra-local-up.sh
docker compose -p "gotchu-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')" \
  --env-file infra/.env -f infra/compose.yaml \
  --profile web --profile coordinator up -d --build web coordinator
```

The setup script creates `infra/.env` with mode `0600`. It contains local database passwords and `AUTH_SECRET`; it does not create identity-provider credentials, organization assignments, an event-signing key, or a worker signing key. GitHub and generic OIDC sign-in are optional. Set `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, and optionally `AUTH_OIDC_NAME` in the local environment file when configuring an OIDC provider. `GOTCHU_EVENT_SIGNING_KEYS_JSON` is an optional web-only local credential-map adapter, with JSON keys mapped to base64-encoded signing keys. It is empty by default and is not production secret custody. Keep this file local. The root `.dockerignore` excludes it and other environment files from image build contexts.

Both app profiles use the root Dockerfile. The build stages use Node 24.18.1, pnpm 11.21.0, and `pnpm install --frozen-lockfile`; runtime images contain production dependencies and compiled output only. The coordinator image also includes `@gotchu/assessment` compiled output, its production dependencies and offline advisory snapshot, plus `@gotchu/demo-target` compiled output, dependencies, and trusted fixture files at their workspace paths. Containers run as the invoking unprivileged UID/GID (1000:1000 by default) with a read-only root filesystem, a writable `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, and CPU, memory, and process limits.

The controlled demo is opt-in: `GOTCHU_DEMO_ENABLED` defaults to `false` for both web and coordinator. Set it to `true` in `infra/.env` to enable the fixed fictional target and assessment flow. When `GOTCHU_DEMO_TARGET_ORIGIN` is unset, the coordinator starts its own trusted target at `127.0.0.1:4100`; an operator may set an approved loopback/private target origin as an override. Compose never publishes port `4100`. The assessment reads only the bundled fixtures and offline advisory snapshot; it does not need a model, paid service, source repository, or external identity provider. Customer-code execution remains disabled.

| Service | Profile | Published address | Readiness gate |
| --- | --- | --- | --- |
| Web | `web` | `127.0.0.1:3000` | Both runtime database logins must be ready. Interactive sign-in needs a separately configured Auth.js identity provider. Routes: `/api/health` and `/api/ready`. |
| Coordinator | `coordinator` | `127.0.0.1:3003` | Postgres, Redis, and at least one assigned organization. Routes: `/health/live` and `/health/ready`. |
| Postgres | always on | `127.0.0.1:55432` | Persistent named volume; bootstrap credentials are not used by app containers. |
| Redis | always on | `127.0.0.1:56379` | Password protected, AOF enabled, persistent named volume. |

No sign-in provider is enabled by default. Configure a supported generic OIDC provider or optional GitHub OAuth when interactive sign-in is needed. The controlled demo itself has no external provider dependency. Fresh second-factor approval remains explicitly unavailable in the web readiness capability data. The coordinator returns 503 while no organization is assigned. Investigator availability is reported separately: deterministic queue processing can be ready without a model worker, and investigation jobs remain visibly unavailable until one is configured.

The coordinator reads `GOTCHU_COORDINATOR_HOST` for its bind address. Its container sets this to `0.0.0.0` so Docker can publish the listener; it does not use the unrelated `HOST` variable. Never publish the database or Redis ports beyond loopback, and do not attach the agent to either data network or mount the Docker socket.

## Network and deployment gates

Postgres, Redis, and app-to-data traffic use the internal `data` network. The local database and coordinator publishing bridges disable inter-container communication and outbound masquerading. Coordinator also joins that host-only bridge so its loopback-published port is reachable while its control-plane, data, and agent links stay internal. Gateway, executor, and agent stay on internal networks. The host scanner binds only the Docker bridge gateway; its HTTPS certificate is generated in the private state directory, and its CA is mounted read-only into the coordinator. Only web joins `web-egress`, a normal Docker bridge, so a configured identity provider can support its OIDC authorization/token flow. This grants broad outbound connectivity; Compose does not enforce destination allowlists or a DNS policy. Production needs a reviewed egress policy for whichever identity provider is configured.

Published app ports use plain HTTP on host loopback for local development. There is no public ingress or TLS-terminating proxy in this Compose stack. Outside local development, `PUBLIC_APP_URL` must be an HTTPS origin and an independently reviewed ingress must terminate TLS before the app is exposed. The current live check verifies outbound HTTPS reachability to its test endpoint; it does not prove OIDC callback/token exchange, public ingress TLS, organization authorization, or fresh-MFA behavior.

The isolated agent profile receives no database, Redis, provider credential, signing key, host path, or Docker socket. Gateway, executor, and scanner profiles stay disabled; the executor has no provider write integration, and customer-code execution remains disabled until a disposable VM-class boundary is demonstrated. Compose container hardening is not a substitute for that boundary.

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

## AWS pilot foundation

Pulumi provisions a configurable AWS region with a public control EC2 host, a private scanner EC2 host, scoped VPC security groups, IMDSv2 enforcement, encrypted EBS root volumes, instance roles, and a private encrypted/versioned S3 bucket. It does not install the application, Postgres, Redis, or a runner service. The scanner receives S3-only egress through a gateway endpoint and has no public IP. Its EC2 host is not a per-job disposable VM boundary and does not enable customer-code execution.

The application remains portable: Postgres and Redis are open-source runtime choices, and object storage and identity are replaceable adapters. This Pulumi package contains the AWS-specific resources only. The first demo service binds to loopback/private port `4100`; that port is not open in the AWS security groups, and the seeded vulnerable demo target must never be exposed publicly. AWS hosting, storage, and egress can incur charges; the infrastructure has not been deployed or priced. See [deployment notes](deployment.md) for credentials, TLS, image delivery, and recovery gaps.
