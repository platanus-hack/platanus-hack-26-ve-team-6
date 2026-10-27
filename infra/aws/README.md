# AWS and GitHub CI/CD retirement

The operator requested removal of Gotchu hosting and deployment automation on 2026-10-27. Development and self-hosting remain local; see [development](../../docs/development.md) and [self-hosting](../../docs/self-hosting.md). Cloud deployment requires a new request.

## AWS verification

Live AWS API checks in account `477010601418`, region `us-east-1`, confirmed removal of:

- Lightsail instance `gotchu-prod`, static IP `gotchu-prod-ip` (`54.81.195.116`), and key pair `gotchu-prod-deploy`. No Gotchu instance snapshots remain.
- S3 buckets `gotchu-prod-backups-477010601418-us-east-1` and `gotchu-prod-releases-477010601418-us-east-1`, including all object versions and delete markers (353 backup entries and eight release entries). Hosted data and cloud backup history were deleted.
- CloudFormation stack `gotchu-production-cicd` (`DELETE_COMPLETE`), its two IAM roles and `Gotchu-InstallProductionRelease` SSM document. The retained release bucket was deleted separately.
- SSM managed node `mi-04d50f702fe2f48e2`, backup IAM user `gotchu-prod-backup` with its access keys and policy, and budget `gotchu-production-monthly`.

No CodePipeline or CodeBuild project existed in the deployment region. An inventory of enabled AWS regions found no additional Gotchu-tagged resources or Gotchu stacks. Other applications' resources were preserved. Shared account identity providers and billing settings were preserved.

## Repository changes

CI, production promotion and deployment workflows, their setup action and affected-package selector were removed. AWS installers, CloudFormation and the unapplied Pulumi provisioner were removed, including its workspace entry and dependencies. Local Compose, the development launcher, self-hosting and local checks remain available.

GitHub Actions is disabled for `0bkevin/gotchu`; its `production` environment and AWS variables were deleted, the retired `prod` release-branch protection was removed, and the custom OIDC subject template was reset. The three workflows in the Platanus mirror were already manually disabled. Workflow definitions and AWS generators were removed from both repositories' `main` branches and the primary repository's `prod` branch. Seven workflow artifacts and 20 caches were deleted from the primary repository, plus one cache from the mirror; no runs were queued, running or waiting. There were no repository Actions secrets or self-hosted runners in the primary repository.

## Outside AWS and GitHub automation

The previously documented Cloudflare DNS record `gotchu.kevinbravo.com` pointed to `54.81.195.116`. The operator removed the DNS record during retirement. Direct queries to both authoritative Cloudflare nameservers confirmed `NXDOMAIN` for A, AAAA and CNAME records after removal; recursive caches can retain the previous address until its TTL expires. Google OAuth clients and the customer-facing GitHub App are application integrations, not deployment automation, and were not deleted.

## Local verification

`pnpm build`, `pnpm typecheck`, `node scripts/gotchu.test.mjs`, frozen/offline lockfile validation and `git diff --check` passed. These local checks are separate from the live AWS/GitHub API and authoritative DNS verification above.
