# `@gotchu/runner`

Per-job Firecracker microVM runner for future isolated validation. Firecracker starts inside a user systemd scope and a bwrap namespace with no host network or home mount. The execution gate opens only after the host sandbox canary passes.

## Threat model

The input archive and everything inside it are hostile. A profile can run project tests and package scripts as guest UID 1000. The runner must assume that package installation, test code, and their output are malicious. Each job gets a fresh rootfs copy, a separate writable scratch block device, and a read-only input block device. The VM is configured without a network device. The guest has no host directory, Docker socket, database, Redis, cloud metadata route, integration credential, or secret mount.

The API exposes fixed `node24-npm-test` and `node24-tsx-selected-v1` profiles; callers cannot choose an argv or shell command. The selected profile runs bounded explicit repository tests using a pinned tsx loader and runner-owned structured reporter; see [selected Node integration and build handoff](SELECTED-NODE.md). The host fetch phase accepts only HTTPS tarballs under the configured npm registry and verifies lockfile sha512 integrity without extracting packages. Tarballs are supplied on a read-only cache disk; both profiles seed npm's cache and run `npm ci --offline --ignore-scripts`. The legacy profile then runs `npm test`; the selected profile uses fixed Node argv. Package lifecycle scripts are suppressed during installation; selected tests and legacy test scripts still execute as untrusted guest code. The VM has no network device. The profile returns regular files beneath `test-results/` and `coverage/`, up to 10 files and 256 KiB total; the host checks each path, size, and SHA-256 before returning base64 content.

The host validates the archive before boot: input size, gzip expansion, compression ratio, file count, tar checksums, duplicate names, traversal, absolute paths, links and special files are bounded or rejected. Results are length-prefixed serial frames, parsed as unknown data and validated against a runtime schema. Firecracker stderr is retained to a 16 KiB tail and returned separately on infrastructure failures. The guest can forge its own claims, so results are untrusted evidence for D05; successful exit alone is not independent validation.

## Gate status and limits

`selfTest()` boots a canary through the real systemd scope and bwrap launch, checks guest and VMM network isolation, confirms the VMM cannot see the host home, verifies scope limits and cleanup, then records a 15-minute result bound to the sandbox and image digests. `checkRunnerGate()` opens only while that record is valid. Network `allowlist` is always rejected because host tap creation and egress filtering are not implemented. There is no Docker or host-process fallback.

The checked-in sandbox policy allows execution only when a recent self-test record matches the current sandbox and image pins. The customer-facing `runJob` refuses to execute while the gate is closed. The bwrap namespace and user systemd scope are a development-host alternative; the jailer remains the preferred production launch path where its root-managed identity and cgroup controls are available.

Firecracker supplies the guest boundary. bwrap removes host network access and the host home from the VMM namespace; systemd applies memory, task and CPU limits to its scope. These controls do not provide a root-owned jailer identity, full resource isolation from the host kernel, protection against kernel or Firecracker escapes, crash/host-loss reconciliation, or production capacity guarantees. `test:vm` is a real-KVM development check and must never be reported as proof that customer execution is enabled.

## Image preparation

Requirements: Linux x86_64, KVM, Docker, `mkfs.ext4`, curl and sha256sum. Set up the workspace with the repository's frozen pnpm lockfile, then run:

```sh
pnpm --filter @gotchu/runner prepare:images
```

The script downloads the official Firecracker `v1.17.0` release archive and checks its published SHA-256 before extraction. It pins a Firecracker CI kernel by exact URL and SHA-256 and pulls the Node base image by platform digest. It exports the rootfs without running customer files, adds the fixed init/agent/reporter and integrity-pinned tsx toolchain, normalizes file metadata and ordering, then builds an ext4 image without root. `prepare:images` verifies that image against the committed rootfs digest. After reviewing an intentional base-image or guest-init change, run `pnpm --filter @gotchu/runner pin:images` to update the lock; it prints the old and new digests. Binaries and disk images live under `~/.cache/gotchu-runner/` by default, or the private path supplied through `GOTCHU_RUNNER_CACHE_DIR` for image preparation, in digest-named files, and are never committed. Runtime APIs use an explicit `cacheDir` option for a private cache.

Preparation is a networked maintainer action. It does not enable the gate. The cache should be deleted and rebuilt after changing any locked source or guest init/agent file.

## API consumed by D05

```ts
selfTest(options?: { cacheDir?: string; signal?: AbortSignal }): Promise<{ status: 'passed' } | { status: 'failed'; reason: string }>
checkRunnerGate(): Promise<{ status: 'open' } | { status: 'closed'; reason: string }>
runJob(job: RunnerJob, options?: { signal?: AbortSignal }): Promise<RunnerResult>
```

`RunnerJob` binds job and organization UUIDs, an opaque input object UUID plus SHA-256 and byte size, fixed profile, profile-specific test selection, bounded vCPU/memory/PID/wall/output/disk limits, and `deny` or `allowlist` network policy. `RunnerResult` is a discriminated union of `completed`, `timed_out`, `resource_exceeded`, `infrastructure_failed`, and `cleanup_uncertain`; every variant includes runner, Firecracker, kernel/rootfs, profile, network and cleanup evidence. Input bytes are resolved through an injected resolver that receives both job and organization scope. The default local resolver reads only `<GOTCHU_RUNNER_INPUT_DIR>/<organizationId>/<objectId>`.

Concurrency defaults to two and the slot is held through VM cleanup. Cancellation kills the VM process group and cleanup removes then verifies the per-job directory. An unverified process or directory returns `cleanup_uncertain`; callers must quarantine that job and retain its capacity pending operator reconciliation.

## Checks

```sh
pnpm --filter @gotchu/runner build
pnpm --filter @gotchu/runner typecheck
pnpm --filter @gotchu/runner test
sg kvm -c 'export PATH=/home/ubuntu/.local/gotchu-bin:$PATH; pnpm --filter @gotchu/runner test:vm'
```

The default unit suite exercises schemas, gate reasons, archive validation and malformed/forged result frames. The VM suite boots real Firecracker microVMs on `/dev/kvm` for package installation, lifecycle suppression, filesystem/network isolation, artifacts, resource limits, timeout, cancellation, exit codes and cleanup. These direct test VMs use known local fixtures; they do not pass through the production gate or jailer and are not production-isolation evidence.
