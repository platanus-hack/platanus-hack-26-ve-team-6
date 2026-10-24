# `@gotchu/runner`

Per-job Firecracker microVM runner for future isolated validation. Firecracker now starts inside a user systemd scope and a bwrap namespace with no host network or home mount, but the product gate remains closed until the sandbox self-test and end-to-end guest protocol pass.

## Threat model

The input archive and everything inside it are hostile. A profile can run project tests and package scripts as guest UID 1000. The runner must assume that package installation, test code, and their output are malicious. Each job gets a fresh rootfs copy, a separate writable scratch block device, and a read-only input block device. The VM is configured without a network device. The guest has no host directory, Docker socket, database, Redis, cloud metadata route, integration credential, or secret mount.

The API exposes one fixed profile, `node24-npm-test`; callers cannot choose an argv or shell command. The host fetch phase accepts only HTTPS tarballs under the configured npm registry and verifies lockfile sha512 integrity without extracting packages. Tarballs are supplied on a read-only cache disk; the guest seeds npm's cache, then runs `npm ci --offline --ignore-scripts` and `npm test`. Package lifecycle scripts are suppressed during installation; test scripts still execute as untrusted guest code. The VM has no network device.

The host validates the archive before boot: input size, gzip expansion, compression ratio, file count, tar checksums, duplicate names, traversal, absolute paths, links and special files are bounded or rejected. Results are length-prefixed serial frames, parsed as unknown data and validated against a runtime schema. The guest can forge its own claims, so results are untrusted evidence for D05; successful exit alone is not independent validation.

## Gate status and limits

`checkRunnerGate()` currently checks KVM access, the pinned Firecracker archive and binaries, guest kernel/rootfs hashes, and the sandbox configuration. It still requires the jailer identity and remains closed because a passing end-to-end host sandbox self-test is not yet recorded. Network `allowlist` is always rejected because host tap creation and egress filtering are not implemented. There is no Docker or host-process fallback.

The checked-in sandbox policy deliberately sets `executionEnabled` to `false`. The customer-facing `runJob` refuses to execute while the gate is closed. The bwrap namespace and user systemd scope are a development-host alternative; the jailer remains the preferred production launch path where its root-managed identity and cgroup controls are available. The current live suite still has failures in the guest result protocol, so no self-test or customer execution is enabled.

Firecracker supplies the guest boundary. bwrap removes host network access and the host home from the VMM namespace; systemd applies memory, task and CPU limits to its scope. These controls do not provide a root-owned jailer identity, full resource isolation from the host kernel, protection against kernel or Firecracker escapes, crash/host-loss reconciliation, or production capacity guarantees. `test:vm` is a real-KVM development check and must never be reported as proof that customer execution is enabled.

## Image preparation

Requirements: Linux x86_64, KVM, Docker, `mkfs.ext4`, curl and sha256sum. Set up the workspace with the repository's frozen pnpm lockfile, then run:

```sh
pnpm --filter @gotchu/runner prepare:images
```

The script downloads the official Firecracker `v1.17.0` release archive and checks its published SHA-256 before extraction. It pins a Firecracker CI kernel by exact URL and SHA-256 and pulls the Node base image by platform digest. It exports the rootfs without running customer files, adds the fixed init/agent, normalizes timestamps, builds an ext4 image without root, and writes the resulting rootfs hash to `images.lock.json`. Review and commit that digest change with any base-image or guest-init update. Binaries and disk images live only under `~/.cache/gotchu-runner/` and are never committed.

Preparation is a networked maintainer action. It does not enable the gate. The cache should be deleted and rebuilt after changing any locked source or guest init/agent file.

## API consumed by D05

```ts
checkRunnerGate(): Promise<{ status: 'open' } | { status: 'closed'; reason: string }>
runJob(job: RunnerJob, options?: { signal?: AbortSignal }): Promise<RunnerResult>
```

`RunnerJob` binds job and organization UUIDs, an opaque input object UUID plus SHA-256 and byte size, fixed profile, bounded vCPU/memory/PID/wall/output/disk limits, and `deny` or `allowlist` network policy. `RunnerResult` is a discriminated union of `completed`, `timed_out`, `resource_exceeded`, `infrastructure_failed`, and `cleanup_uncertain`; every variant includes runner, Firecracker, kernel/rootfs, profile, network and cleanup evidence. Input bytes are resolved through an injected resolver that receives both job and organization scope. The default local resolver reads only `<GOTCHU_RUNNER_INPUT_DIR>/<organizationId>/<objectId>`.

Concurrency defaults to two and the slot is held through VM cleanup. Cancellation kills the VM process group and cleanup removes then verifies the per-job directory. An unverified process or directory returns `cleanup_uncertain`; callers must quarantine that job and retain its capacity pending operator reconciliation.

## Checks

```sh
pnpm --filter @gotchu/runner build
pnpm --filter @gotchu/runner typecheck
pnpm --filter @gotchu/runner test
GOTCHU_TEST_VM=1 sg kvm -c 'export PATH=/home/ubuntu/.local/gotchu-bin:$PATH; pnpm --filter @gotchu/runner test:vm'
```

The default unit suite exercises schemas, gate reasons, archive validation and malformed/forged result frames. The opt-in VM suite boots real Firecracker microVMs on `/dev/kvm` for filesystem/network/metadata checks, resource/output limits, timeout, cancellation, exit codes and cleanup. These direct test VMs use known local fixtures; they do not pass through the production gate or jailer and are explicitly not production-isolation evidence.
