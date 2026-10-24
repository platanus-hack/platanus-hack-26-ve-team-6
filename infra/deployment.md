# AWS deployment foundation

## Product stage and portability

The first deliverable is a controlled demonstration application assessed internally and externally, with evidence-backed comparison reports. Core assessment uses deterministic local checks and an attributed advisory snapshot; it does not require a model or paid API. An external assessment must work without repository source access, stay within explicitly authorized scope, and report confirmed observations, indications, unknown coverage, severity, confidence, and exploitability separately. This infrastructure does not expose a public assessment target.

The Compose controlled demo is opt-in through `GOTCHU_DEMO_ENABLED` (default `false`). With the demo enabled and no operator target override, the coordinator starts its bundled trusted target on loopback port `4100`; Compose and the AWS security groups do not publish or open that port. An optional `GOTCHU_DEMO_TARGET_ORIGIN` is coordinator-only and must identify an approved loopback/private target. The coordinator runtime image preserves the assessment package, offline advisory snapshot, demo target, and fixture paths needed for the bounded profiles. Customer code, package install scripts, and customer tests remain disabled.

Live monitoring, approval, bounded automation, and provider recovery are later stages. This foundation does not implement those capabilities. Auth.js accepts optional generic OIDC settings (`AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, and `AUTH_OIDC_NAME`) alongside optional GitHub OAuth; the controlled demo requires no external identity provider. AWS identity is optional, and no sign-in provider is enabled by this infrastructure. PostgreSQL and Redis remain self-hosted/open-source runtime choices. Storage, identity, and model adapters remain replaceable; AWS-specific resources and policies stay in this Pulumi package.

## Provisioned AWS resources

The Pulumi program provisions two configurable EC2 instance types in one configurable AWS region and one Availability Zone. Defaults are `us-east-1`, `t3.small` for control, and `t3.medium` for the scanner. These are starting values, not measured capacity or a cost estimate.

| Resource | Configuration and boundary |
| --- | --- |
| VPC and subnets | `10.42.0.0/16`; control uses a public `/24`, scanner uses a private `/24`. One Availability Zone keeps this pilot foundation small and does not provide AZ redundancy. |
| Public route | Internet gateway and default route attach only to the control subnet. Control gets a dynamic public IPv4 address; no Elastic IP or DNS record is provisioned. |
| Scanner route | No internet default route and no NAT gateway. A regional S3 gateway endpoint is attached to the scanner route table. |
| Control security group | Public IPv4 TCP 80/443 for a separately installed TLS ingress; TCP 22 only from configured operator CIDRs. Egress is TCP 443 to any public IPv4 destination, VPC DNS, and SSH to the scanner subnet; there is no destination allowlist. |
| Scanner security group | No public IP. Inbound SSH is allowed only from the control security group. Egress is HTTPS to the S3 gateway endpoint prefix list only. No app, database, Redis, or port `4100` rule is open. |
| EC2 instances | Ubuntu 24.04 x86-64 AMIs from Canonical, required IMDSv2 tokens with hop limit 1, and encrypted 30 GiB `gp3` root EBS volumes. Both instances are protected from Pulumi destroy by default. |
| S3 bucket | Private, bucket-owner enforced, all four S3 public-access blocks enabled, TLS required by bucket policy, SSE-S3 enabled, versioning enabled, and Pulumi deletion protection enabled. There is no lifecycle or retention rule. |
| Instance IAM | Control can list only named storage prefixes, read the artifact, backup, runner-bootstrap, input, and result prefixes, and write artifacts, backups, runner-bootstrap, and inputs. Scanner can read only runner-bootstrap and input objects and write only scanner results. Neither role can delete objects. |

The bucket policy and security groups are AWS-specific. An application-side S3-compatible storage adapter can be replaced without changing the core assessment contracts. Postgres and Redis remain self-hosted/open-source runtime choices, and identity and model services remain replaceable adapters. Container images are replaceable release artifacts. This AWS foundation does not provision managed database/cache services or configure either daemon on EC2.

The scanner IAM role and S3 endpoint support a future private image path: a trusted release workflow could place a pinned OCI archive under `scanner-bootstrap/`, and the scanner host could retrieve it without a public address. No image publisher, checksum/signature verifier, host bootstrap, image loader, or scanner service is implemented here. The control host has outbound HTTPS for operator-managed image delivery, but that security-group rule is not limited to named endpoints. The scanner cannot reach package repositories, public registries, GitHub, or other internet destinations; it needs a reviewed base-image refresh or controlled package-delivery process. Do not treat the IAM policy or mocked Pulumi tests as proof that an image can be installed or a scan can run.

## Configuration and credentials

The Pulumi AWS provider uses the normal AWS SDK credential chain. Prefer an operator SSO profile or a short-lived assumed role and verify the account before later infrastructure operations. Do not put AWS access keys in `Pulumi.*.yaml` or application environment files. The deployment identity needs AWS permissions to create VPC, EC2, security-group, IAM role/profile/policy, S3, and route/endpoint resources; use a dedicated account or permission boundary and review the actual policy before granting it. Pulumi state also contains infrastructure metadata and must use a trusted backend with access control and encryption.

Create a local stack and set its non-secret configuration:

```sh
cd infra/pulumi
pulumi stack init demo
pulumi config set gotchu:awsRegion us-east-1
pulumi config set gotchu:artifactBucketName 'globally-unique-private-bucket-name'
pulumi config set gotchu:sshPublicKey "$(cat ~/.ssh/id_ed25519.pub)"
pulumi config set --path gotchu:sshAdminCidrs[0] '198.51.100.10/32'
pulumi config set gotchu:controlInstanceType t3.small
pulumi config set gotchu:scannerInstanceType t3.medium
pulumi config set gotchu:customerCodeExecutionEnabled false
pnpm test
pnpm typecheck
```

Replace the documentation-only key and CIDR with real operator values. Restrict SSH to a known operator address. The example config file is a template, not a usable key or bucket name. The program rejects `customerCodeExecutionEnabled: true` while VM-class isolation evidence has not been reviewed. No AWS preview or deployment has been run for this change; mocked policy tests do not contact AWS and do not establish that the account can deploy these resources.

## Application delivery and public ingress

Pulumi creates hosts and storage only. It does not install Docker, copy images, set secrets, start web/coordinator services, install a database, configure TLS, run migrations, or install the scanner. A real deployment needs an operator-reviewed release process that pins images by digest, transfers them through a trusted channel, verifies provenance, and rolls back safely. Keep application and database credentials in an appropriate secret store; the EC2 instance roles above are for S3 objects only.

Before exposing the control-plane web service, point a DNS name using an operator-selected DNS provider at the control host's current public IP, then configure a TLS terminator on that host or another reviewed ingress. The security group allows port 80 for HTTP redirect/ACME challenge and port 443 for HTTPS; no certificate, renewal, proxy, DNS integration, or stable address is provisioned. Set the application public URL to the final HTTPS origin. Bind the web app and all internal services to loopback/private interfaces; do not publish Postgres, Redis, coordinator, gateway, or port `4100`. The public TLS path and OAuth/OIDC callbacks require a real deployment verification.

Use the local Compose guide for the existing OSS Postgres/Redis and web/coordinator setup. This AWS plan does not make a cloud identity or repository vendor mandatory. Configure a generic OIDC provider only after its application adapter and secret custody are available; no GitHub, Cognito, or other login credentials are created by Pulumi.

## Backups, recovery, and cost gates

S3 versioning protects prior object versions from ordinary overwrites, but it is not a database backup or a tested recovery plan. No automated Postgres dump/WAL archive, EBS snapshot schedule, backup retention policy, cross-account copy, restore automation, or recovery drill is present. The control host's root disk is encrypted but not backed up. Before a pilot, define backup consistency, retention, access, deletion, and recovery ownership; restore into a clean environment and measure the accepted data loss and time to service. After a restore, invalidate pre-restore approvals, reconcile provider executions, and keep writes frozen until state is reconciled. Existing recovery objectives are targets, not demonstrated guarantees.

AWS resource use, storage, requests, and data transfer can incur charges. No free-tier assumption or operating-cost estimate is made here. Check current AWS pricing before provisioning. The proposed pilot spending ceiling and any recovery targets need current pricing review and measured exercises before they can be treated as gates passed.

## Local checks

`pnpm test` runs Pulumi mock resource-policy/configuration checks without AWS credentials. `pnpm typecheck` checks the package types. These checks validate the declared resource inputs; they do not prove cloud API acceptance, public TLS, image delivery, backup creation, restoration, scanner isolation, or customer-code isolation. Do not run a cloud preview or deployment as part of this local implementation task.
