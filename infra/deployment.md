# Gotchu infrastructure foundation

This directory defines local data services, runnable web/coordinator images, and a proposed DigitalOcean two-droplet foundation. Gateway, agent, executor, and scanner Compose profiles remain disabled. The Pulumi program has policy/configuration tests; it has not been deployed. Follow [the local runtime guide](README.md) for app startup and readiness configuration.

## Local development data services

Generate local-only credentials first. The script creates `infra/.env` with mode `0600`, random Postgres/Redis and runtime-login passwords, and an Auth.js secret. It refuses to replace an existing file and never prints values.

```sh
scripts/infra-local-setup.sh
scripts/infra-compose-validate.sh
scripts/infra-local-up.sh
scripts/infra-live-check.sh
```

`infra-local-up.sh` starts Postgres and Redis under a worktree-specific Compose project. Persistent volumes survive restarts and `scripts/infra-local-down.sh`. The live check creates a separate project with temporary credentials and volumes, verifies pinned service versions, loopback connectivity and persistence after restart, and then removes only its own project. If Docker or its daemon is unavailable, the script exits with a clear failure; it does not count an unavailable daemon as a pass.

| Service | Compose profile | Local access | Credentials and trust boundary |
| --- | --- | --- | --- |
| PostgreSQL 17.11 | Always on | `127.0.0.1:55432` | Bootstrap operator login is generated locally. Migrations use this operator connection; application connections use distinct logins provisioned by `@gotchu/database`. |
| Redis 7.4.11 | Always on | `127.0.0.1:56379` | Password protected, AOF enabled, persistent volume. Only the trusted coordinator receives its URL. |
| Web | `web` | `127.0.0.1:3000` | `gotchu_api` and separate `gotchu_ingest` runtime login URLs; Auth.js settings. |
| Coordinator | `coordinator` | `127.0.0.1:3003` | `gotchu_coordinator` login and Redis; optional worker URL and capability signing key. Health endpoints are `/health/live` and `/health/ready`. |
| Gateway | `gateway` | Internal port 3002 | Its own login in the `gotchu_coordinator` role and the public run-capability verification key. No Redis or signing private key. |
| Isolated agent (`apps/worker`) | `agent` | Internal port 3001 | Joins only `agent-link`; receives no database, Redis, provider credentials, or capability-signing private key. |
| Executor | `executor` | Not published | Separate `gotchu_executor` login. Provider writes and provider credentials remain disabled. |
| Scanner boundary | `scanner` | Not published | Isolated static network with no host paths, Docker socket, database, Redis, or control-plane credentials. It does not run customer code. |

`docker compose up` starts only the data services. Profiles are opt-in. Web and coordinator now build and run real images; the other four profiles exit with status 78. The web profile serves `/api/health` and `/api/ready` from its built Nitro output. Auth.js configuration is `PUBLIC_APP_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, and `AUTH_GITHUB_SECRET`; optional `GOTCHU_EVENT_SIGNING_KEYS_JSON` supplies the local web-only signing-key adapter. Setup generates no provider or event-signing secrets. Fresh MFA approval remains unavailable.

The coordinator interface is `GOTCHU_COORDINATOR_DATABASE_URL`, `GOTCHU_REDIS_URL`, `GOTCHU_ORGANIZATION_IDS`, optional `GOTCHU_WORKER_URL`, and optional `GOTCHU_RUN_CAPABILITY_PRIVATE_KEY`. Its container binds through `GOTCHU_COORDINATOR_HOST`. The gateway requires a separate coordinator-role login, an SPKI public verification key, and TLS configuration; the coordinator signs with its PKCS8 private key. No keys are generated here. The model provider remains unavailable and this stack supplies no model credential. Stop the old shared-queue coordinator before upgrading to the reserved deterministic/investigation lanes; Postgres reconciliation recovers unfinished old deliveries. The executor remains disabled until its provider service and trusted approval adapters exist.

Postgres and Redis join an internal `data` network and a local publishing bridge with peer communication and masquerading disabled. Coordinator has a dedicated host publishing bridge with the same restrictions; web has an egress bridge for GitHub HTTPS. Compose does not restrict that egress by destination. Only Postgres, Redis, web, and coordinator publish ports, all on loopback. Data and app containers use unprivileged runtime UIDs, read-only roots, dropped capabilities, and resource limits. Persistent data is writable through named volumes. A deployed TLS ingress, provider egress policy, and scanner/VM isolation are separate gates.

The `@gotchu/database` migrations create the non-login group roles and schema. Local bootstrap invokes its migration command using the generated operator URL, then provisions five distinct logins: API, ingest, coordinator, gateway, and executor. Gateway is a separate login granted only the coordinator group role. Runtime logins are not table owners and must not have `BYPASSRLS` or elevated role attributes. Never configure an app with the operator/migration URL.

Postgres 17.11 is pinned to the supported Node `pg` compatibility range; Redis 7.4.11 is from its maintained extended-support line. The image versions are pinned to patch releases rather than floating major tags. See the [PostgreSQL 17.11 release](https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/), [node-postgres compatibility](https://node-postgres.com/), and [Redis 7.4 release notes](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisce-7.4-release-notes/).

## DigitalOcean baseline

The Pulumi TypeScript package defines two Ubuntu 24.04 Droplets in one private VPC:

- The control Droplet has public networking. Its tagged firewall allows public TCP 80/443 and TCP 22 only from operator-configured SSH CIDRs. Its outbound rules allow HTTPS, DNS, and NTP plus SSH only to the scanner tag.
- The scanner Droplet has public networking disabled. Its tagged firewall accepts SSH only from the control Droplet tag and allows outbound TCP 443 only to that tag. Customer code execution is not enabled by this foundation.
- A private DigitalOcean Space is created with the `private` ACL, object versioning, and deletion protection. DigitalOcean documents that the private ACL blocks public access. Spaces encrypts stored files on physical disks with 256-bit AES-XTS; Spaces does not provide bucket-level server-side encryption configuration, so this definition does not claim customer-managed object encryption. The application must use HTTPS and may add client-side encryption where the data policy requires it.

The firewall is created against stack-specific tags before each Droplet is created, so the firewall policy is attached as the Droplet appears. SSH CIDRs are validated as explicit, narrow IPv4/IPv6 ranges; `0.0.0.0/0` and `::/0` are rejected. The program uses encrypted Pulumi secrets for the DigitalOcean API token and Spaces key pair. It only provisions network, firewall, Droplet, and object-storage resources; it does not install or run application services, Postgres, Redis, a Docker sandbox, or a VM job supervisor.

Set encrypted secrets and operator configuration in a local Pulumi stack, then run unit/config validation before considering any cloud plan:

```sh
cd infra/pulumi
pulumi stack init dev
pulumi config set --secret gotchu:digitalOceanToken
pulumi config set --secret gotchu:spacesAccessId
pulumi config set --secret gotchu:spacesSecretKey
pulumi config set gotchu:sshPublicKey 'ssh-ed25519 ...'
pulumi config set --path gotchu:sshAdminCidrs[0] '198.51.100.10/32'
pulumi config set gotchu:spacesBucketName 'unique-private-bucket-name'
pnpm test
pnpm typecheck
```

The commands above describe configuration only. No Pulumi preview or deployment has been run. DigitalOcean resources incur charges and require an operator-owned account and keys. The proposed USD 250/month budget, 15-minute recovery-point target, and four-hour recovery-time target remain unverified. A disposable VM-capable runner with demonstrated isolation remains a release gate; Docker containers are not an approved substitute. The `customerCodeExecutionEnabled` Pulumi setting is rejected while VM-class isolation evidence is absent.

Provider references: [Pulumi DigitalOcean Droplets](https://www.pulumi.com/registry/packages/digitalocean/api-docs/droplet/), [VPCs](https://www.pulumi.com/registry/packages/digitalocean/api-docs/vpc/), [Firewalls](https://www.pulumi.com/registry/packages/digitalocean/api-docs/firewall/), [Spaces buckets](https://www.pulumi.com/registry/packages/digitalocean/api-docs/spacesbucket/), [Spaces ACL compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/), and [DigitalOcean encryption overview](https://www.digitalocean.com/resources/articles/cloud-encryption).

## CI checks

`.github/workflows/ci.yml` configures frozen installation, workspace build/typecheck/package tests, Compose policy and image probes, and isolated database/backend, gateway, executor, and full pipeline suites. Compose checks include repeatable role bootstrap, restart persistence, readiness, loopback publishing, GitHub TLS, and teardown. Pulumi policy tests use mocks without cloud credentials. Remote CI results have not been claimed; locally executed checks are recorded in [validation](../docs/validation.md).
