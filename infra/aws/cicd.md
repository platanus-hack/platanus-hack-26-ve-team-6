# Production releases

`main` remains the development integration branch. Production changes are promoted through a `main` → `prod` PR; merging that PR authorizes delivery to the existing `gotchu-prod` Lightsail server. Keep changes in main, including hotfixes. Do not maintain a second application implementation in prod.

## Normal release

1. Merge a feature PR into main after `required-checks` passes. This gate requires every selected CI job to succeed; jobs run in parallel according to the affected packages.
2. Successful main CI opens or updates **Release main to production**. Review its current diff. GitHub may require **Approve workflows to run** for checks on a bot-created PR; approve those checks before merging.
3. Merge the promotion PR after its checks pass. `prod-source` permits only this repository's main branch and is emitted only for a PR into prod; unrelated CI uses a different check name so its skipped job cannot satisfy this protection. Neither promotion nor deployment merges PRs automatically.
4. **Deploy production** runs the complete CI again for the exact prod commit. A separate job builds a Linux/amd64 archive with production dependencies and verifies workspace imports outside the checkout.
5. A minimal delivery job uses temporary AWS credentials, conditionally creates the immutable release object, checks that prod has not advanced, sends the fixed SSM command and waits for the host outcome. Deployment success requires the actual host command to finish successfully.

The `production` environment accepts branch `prod` only, not tags. Main/prod require PRs and their checks, apply protections to administrators, and block deletion and force pushes. There is no extra required reviewer count: the owner can make the explicit release decision by merging. Do not replace a promotion with a feature-branch PR to prod.

## AWS identity and storage

Infrastructure is declared in [cicd.yaml](cicd.yaml), stack `gotchu-production-cicd`, region `us-east-1`.

- `gotchu-prod-releases-477010601418-us-east-1`: private, versioned, encrypted, TLS-only S3 releases. Conditional `If-None-Match: *` is mandatory. Keys contain the commit, workflow run ID and attempt; retention is 30 days. This bucket is separate from recovery backups.
- `gotchu-github-production-deploy`: only release-object upload, the exact install document/managed host, and command-result reads. It cannot edit documents, change infrastructure, open SSH or change other projects. AWS does not support resource scoping for `GetCommandInvocation`, so reads of known command results are account-wide; the role cannot list commands. Keep secrets out of command output.
- `gotchu-production-managed-host`: SSM's managed-node policy and read-only access to release objects. The registered node is `mi-04d50f702fe2f48e2`; hybrid credentials rotate in root-only `/root/.aws/credentials`. The host CLI's assumed-role identity was verified; no developer/root AWS credentials were installed.
- `Gotchu-InstallProductionRelease`, version 1: validates release/checksum parameters, uses environment interpolation and invokes the independently installed root-owned control. It accepts no arbitrary shell command.

GitHub uses custom OIDC subject claims `repo,ref` while retaining immutable repository identity. IAM requires audience `sts.amazonaws.com` and exact subject `repo:0bkevin@79945749/gotchu@1431765006:ref:refs/heads/prod`. The ref remains bound even when the job uses a GitHub environment. Preserve this template; verify the API's returned subject prefix if the repository identity changes. No AWS access key is a GitHub secret.

Production environment variables: `AWS_DEPLOY_ROLE_ARN`, `AWS_RELEASE_BUCKET`, `AWS_MANAGED_INSTANCE_ID`. These are identifiers, not credentials.

To recreate the stack, first apply the template with the verified `OidcSubject`. Register the intended host with a one-use SSM hybrid activation using the stack's `HostRole`, delete the activation after registration, then update `ManagedInstanceId` to its real ID. Do not reuse another application's managed node. Deploy the template with `CAPABILITY_NAMED_IAM`, retain its tags, and verify the host identity and IAM boundaries before enabling GitHub delivery.

## Host installation and transaction

One-time operator setup uses [install-delivery-controls.sh](install-delivery-controls.sh). Stage it together with the release helpers, `wait-maintenance.sh`, `backup.sh`, `refresh-scanners.sh` and `scripts/update-trivy-db.mjs` (beside the installer). Run as root with the original deployed full commit SHA. It waits for running oneshots, requires a fresh backup, retains the entire original app under `/opt/gotchu/releases/initial-<sha>` and makes `/opt/gotchu/app` a symlink. It preserves `/etc/gotchu`, database volumes and runtime private directories. Do not rerun adoption against an already adopted installation.

Controls live in `/usr/local/sbin/gotchu-install-release` and `/usr/local/lib/gotchu-deploy`, outside release archives. Updating these controls requires a separate reviewed operator installation. A normal application release does not replace them or reinstall service environment files. Scanner metadata lives in the real persistent directory `/var/lib/gotchu-scanner/trivy-db`; release paths link there, and the refresh command explicitly uses the real path.

Deployment, backup and scanner refresh share `/run/lock/gotchu-maintenance.lock`. The installer verifies SHA256 and validates archive members/links before extraction. It records a durable transaction in `/var/lib/gotchu-deploy/state.json`, rejects older generations and treats successful identical commands as idempotent. An unfinished transaction blocks further installations until reconciled.

Before switching, it snapshots actual migration names/checksums, completes an encrypted off-host backup, stops public traffic, stops coordinator before scanner, and uses the existing transactional migrator with host-only credentials. It then switches the release symlink, checks scanner/web TLS and coordinator readiness, reopens Caddy and checks public HTTPS. The deployment record and `/etc/gotchu/release.txt` identify the installed commit. The adopted original and three recent releases are retained; the immediately previous release is protected from cleanup.

## Failure and recovery

- A failure before stopping the runtime leaves the current application running.
- Before public exposure, the installer can resume the previous runtime only after proving actual database migration state is unchanged. It restores the previous release marker as well.
- Changed/unknown migration state, failure after public exposure, or failure to restart the previous runtime leaves application/public services stopped with `recovery_required`. It never automatically restores a database backup or downgrades migrations.
- A workflow timeout is an unknown outcome, not proof that the remote command stopped. Inspect its SSM command ID and the host ledger before retrying. A crashed install remains blocked for reconciliation.

Inspect `aws ssm get-command-invocation`, the host ledger and its `transactions/<release>/before.json`, `after.json` or `after-failure.json`, plus the service journals. Do not clear an unfinished ledger until the command has terminated and an operator has established which symlink, database schema and services are current. Reconcile provider approvals after any database restoration using the existing recovery procedure in [README.md](README.md).

For a normal rollback after a successful release, prepare a new main commit reverting the application change while retaining forward-compatible migrations; promote it normally. Schema/data compatibility still needs review. Do not reset prod or point it at an arbitrary old commit.

To retry a completed failed attempt, choose **Re-run all jobs** so packaging and delivery share the new run attempt. To redeploy the current prod without a new merge, dispatch **Deploy production** with branch **prod** selected; dispatching it on another branch performs no deployment.

This retains a single host with a short maintenance interruption per switch. It adds no new compute service. S3 storage/requests and GitHub Actions can incur usage charges; the existing budget is an alert, not a hard spending cap. Standard-tier SSM was verified. Recovery objectives, aggregate capacity and full clean-host recovery remain separate release gates.

## Validation

The host controls have focused archive traversal/link/device/mode, replay/stale/crash-state, and executing-oneshot regression tests. These simulate boundaries and do not substitute for live AWS delivery. CI also runs real disposable Postgres/Redis and application integration checks. Record the actual first deployment result separately; configuration or a dispatched SSM command alone is not evidence of successful delivery.
