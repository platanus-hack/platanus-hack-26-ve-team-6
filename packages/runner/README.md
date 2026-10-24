# `@gotchu/runner`

Per-job Firecracker microVM runner for future isolated validation. The product path remains closed while the jailer-backed host sandbox is incomplete and independently unvalidated.

## Threat model

The input archive and everything inside it are hostile. A profile can run project tests and package scripts as guest UID 1000. The runner must assume that package installation, test code, and their output are malicious. Each job gets a fresh rootfs copy, a separate writable scratch block device, and a read-only input block device. The VM is configured without a network device. The guest has no host directory, Docker socket, database, Redis, cloud metadata route, integration credential, or secret mount.

The API exposes one fixed profile, `node24-npm-test`; callers cannot choose an argv or shell command. It attempts `npm ci --ignore-scripts --offline` and then `npm test`. Package lifecycle scripts are suppressed during installation; test scripts still execute as untrusted guest code. No network fetch phase or npm cache-image builder is implemented yet, so projects requiring uncached dependencies fail closed during `npm ci`. A future fetch phase must resolve exact lockfile integrity on the host, then provide a read-only cache object to the guest.

The host validates the archive before boot: input size, gzip expansion, compression ratio, file count, tar checksums, duplicate names, traversal, absolute paths, links and special files are bounded or rejected. Results are length-prefixed serial frames, parsed as unknown data and validated against a runtime schema. The guest can forge its own claims, so results are untrusted evidence for D05; successful exit alone is not independent validation.

## Gate status and limits

`checkRunnerGate()` checks KVM access, the pinned Firecracker archive and extracted binaries, guest kernel/rootfs hashes, and the jailer policy file. It returns an explicit closed reason if any prerequisite is missing. Network `allowlist` is always rejected because host tap creation and egress filtering are not implemented. There is no Docker or host-process fallback.

The checked-in sandbox policy deliberately sets `executionEnabled` to `false`. The adapter currently boots a real VM only through a private test helper; the customer-facing `runJob` refuses to execute while the gate is closed. Even after opening that gate, the design needs a root-owned jailer launch, cgroup PID enforcement, crash/host-loss reconciliation, an exact offline package-cache path and independent isolation review. The current tests do not establish production isolation, capacity, cost, AWS availability or VM escape resistance.

Firecracker supplies a VM boundary, but the current direct test harness does not exercise the jailer. `test:vm` is only a real-KVM development check of the guest/device behavior and cleanup. It must never be reported as proof that customer execution is enabled.

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
