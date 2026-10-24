# Scanner service (development)

Coordinator interface, exported by `@gotchu/scanner`:

```ts
interface ScannerClientOptions {
  origin: string;
  secret: Uint8Array; // 32–1024 bytes, held only by coordinator/scanner host
  ca?: Uint8Array; // optional scanner-specific CA bundle; HTTPS only
  timeoutMs?: number; // default 60,000; maximum 65,000
  allowDevelopmentHttp?: boolean; // explicit literal-loopback opt-in
}
const client = createScannerClient(options);
const report = await client.run(input); // CustomerRunInput -> Promise<CustomerAssessmentReport>
```

`input` is the exact persisted version 2 request returned by `backend.customers.getRequest`. No caller URLs or scanner options are added. The client validates both runtime contracts and exact report scope/subject binding. Coordinator persistence still revalidates its durable lease, target authorization/version, and source binding. TLS is verified by default. `ca` optionally supplies a private CA bundle to this scanner request only and is rejected for HTTP; it does not change process-wide trust or the HTTPS assessment target's trust. HTTP requires both `allowDevelopmentHttp: true` and `NODE_ENV=development|test`, and only canonical literal `127.0.0.1` or `[::1]` origins. Paths, credentials, queries, fragments and redirects are refused; no environment proxy is used.

`createScannerServer({ secret, runner?, tls?: { cert, key } })` returns a Node HTTP server without `tls`, or an HTTPS server when a TLS identity is supplied. `runner` implements `run(input): Promise<CustomerAssessmentReport>` and `readiness(): Promise<{ ready: boolean; tools: { name: string; available: boolean }[] }>`; the default is `createCustomerAssessmentRunner()`. The host has no DB/Redis access. It is a separate process called by the durable coordinator, not code inside a customer-facing route. No customer code is executed. The trusted host alone orchestrates fixed parser containers; scanner jobs receive no service secret or Docker socket.

## Local process configuration

`NODE_ENV=development pnpm --filter @gotchu/scanner start` runs the built `dist/main.js`. The listener defaults to `127.0.0.1:4400`; `GOTCHU_SCANNER_HOST` and `GOTCHU_SCANNER_PORT` configure the bind host and port. Startup logs the host and port. Required `GOTCHU_SCANNER_SECRET_FILE` names a local credential file containing the raw shared bytes (no trimming/base64 decoding). Set `GOTCHU_SCANNER_OSV=1` to explicitly enable the bounded package-name/version-only OSV adapter. Without it, advisory coverage is unavailable and aggregate readiness is unready. No secret is printed, placed in process arguments or inherited by child jobs. Keep the credential file out of version control. SIGINT/SIGTERM stop accepting work and allow active bounded requests to finish.

The customer development launcher starts the scanner as a separate process and supplies a private secret-file path; it owns process/PID/port records and credential-file cleanup. Embedded callers and tests can instead use `createScannerServer` directly and share the secret in memory.

## Standalone TLS runtime configuration

`apps/scanner/src/main.ts` can serve production traffic directly over HTTPS. `NODE_ENV=production` requires both TLS files even on loopback. Without TLS, only `development` or `test` on a literal loopback IP may use HTTP; the configured host must always be a literal IP address. The default host is `127.0.0.1`, and the default port is `4400`.

| Environment variable | Meaning |
| --- | --- |
| `GOTCHU_SCANNER_HOST` | Literal IPv4 or IPv6 bind address; defaults to `127.0.0.1`. |
| `GOTCHU_SCANNER_PORT` | Port from 1024 through 65535; defaults to `4400`. |
| `GOTCHU_SCANNER_SECRET_FILE` | Required file with 32–1024 raw HMAC secret bytes. |
| `GOTCHU_SCANNER_TLS_CERT_FILE` | PEM server certificate; configure together with the key file. |
| `GOTCHU_SCANNER_TLS_KEY_FILE` | Matching PEM private key; TLS uses a minimum of TLS 1.2. |
| `GOTCHU_SCANNER_OSV` | Set to `1` to enable bounded OSV package-name/version lookups; unset or `0` disables them. |

Secret, certificate, and key inputs must be nonempty regular files and are opened without following symlinks. Reads are bounded at 1 KiB for the secret, 256 KiB for the certificate, and 64 KiB for the key. The certificate and key must form a valid TLS identity. Keep these files private and outside version control.

The coordinator may set `GOTCHU_SCANNER_CA_FILE` to a nonempty PEM bundle containing CA certificates (maximum 256 KiB). It is accepted only when `GOTCHU_SCANNER_ORIGIN` uses HTTPS. Validated certificate blocks are canonicalized before the CA bundle is returned and used by that scanner client. The CA does not alter global TLS trust, target HTTPS validation, or other outbound requests. The CA file is read as a bounded regular file without following symlinks.

## Wire contract and bounds

`POST /v1/assessments`, `Content-Type: application/json`, `x-gotchu-timestamp` as decimal Unix seconds and `x-gotchu-signature` as 64 lowercase HMAC-SHA256 hex characters. The signing bytes are UTF-8 `gotchu-scanner-v1\n${timestamp}\n` followed by the exact raw body bytes. `signScannerBody` and `verifyScannerSignature` are exported. Timestamp window is ±60 seconds; comparison is constant-time. Repeated signatures are rejected for their full validity window by a bounded in-memory map. This is process-local replay protection, not durable exactly-once execution; the backend job/lease/report transaction remains authoritative after restarts.

One active intake/run per service, no waiting queue, at most 16 connections. Intake deadline 30 seconds, raw header cap 8 KiB, signed request cap 12,000,000 bytes (source snapshots remain capped at 4 MiB; uploaded image archives at 8 MiB before base64 encoding), result cap from `CUSTOMER_MAX_REPORT_BYTES` (1 MiB), service response deadline 55 seconds (client/gateway reads remain 60 seconds). The default core deadline is 55 seconds. Client result buffering is streaming-capped. HTTP errors contain stable codes only, never source, credentials, raw parser output or exception details. Busy returns 429, replay 409, signature rejection 401, invalid input 400 and unavailable execution 503. A timed-out runner retains the admission slot until all its operations and cleanup actually settle. A cleanup fault latches readiness and admission unavailable until operator reconciliation and supervisor restart; it never produces a success report.

Image CVE scans accept an uploaded `docker save`/OCI tar archive (8 MiB maximum) or a public image reference pinned by digest. Supported public registries are Docker Hub, GHCR, Quay, public ECR and `gcr.io`; credentials and private registries are not supported. The host pulls only the exact public digest with Docker auth disabled, then exports an archive. The image is never created as a runnable container. Trivy scans the archive in image mode, and its scanner container has no network access. OS and language package CVEs include fixed-version and available layer evidence. Unsupported distributions and package ecosystems remain unknown; the Java index database is omitted, so Java package CVE coverage is explicitly unknown.

Trivy's main vulnerability database is refreshed outside assessment requests. `scripts/update-trivy-db.mjs` resolves the public `ghcr.io/aquasecurity/trivy-db:2` tag to its current immutable OCI manifest digest, downloads only that digest with the pinned Trivy image, and writes the database checksum and metadata timestamp to a local lock. `GOTCHU_SCANNER_TRIVY_DB_DIRECTORY` points at the verified directory. The scanner accepts only a checksum-valid cache no older than 14 days. Trivy requires write access to its Bolt DB even with updates disabled, so the database directory is writable only by the isolated scanner UID and its SHA-256 is verified before and after every image scan; no in-scan database update or network access occurs. A verified cache can support offline operation until it reaches that limit. The Java index DB is deliberately not downloaded due to its large size.

`GET /readyz` returns 200 only when the actual pinned parser profile self-tests and configured advisory readiness succeed; otherwise 503 with per-tool availability. Concurrent probes share one aggregate readiness operation and a 30-second result cache. Readiness uses the same admission slot as assessments, responds within 40 seconds, and retains that slot if the underlying probe hangs. See [engine profiles and sandbox limits](../../packages/customer-assessment/README.md). Missing tools are not green readiness and do not produce invented clean reports.

## Checks

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/customer-assessment build
pnpm --filter @gotchu/scanner build
pnpm --filter @gotchu/scanner typecheck
pnpm --filter @gotchu/scanner test
```

Service tests use real HTTP sockets with an explicitly injected unavailable-scanner runner: they test authentication, replay, request/result caps, deadlines, one-run admission, redirects and report-binding rejection. They are not scanner accuracy tests. The engine's `test:live` runs real Docker profiles and OSV with positive and corrected controls. The coordinator's `test:live` includes a real Postgres/Redis durable image job using a tiny public digest-pinned Alpine image and the pinned local Trivy scanner; the runner removes only the exact image it pulled. No AWS resources, cloud deployment, production credentials, customer execution or provider writes are involved.

After CA canonicalization, focused local Linux/amd64 checks passed for the production-mode scanner/coordinator TLS path and the separate production smoke. These checks cover the exercised durable path, not a cloud deployment or every supported architecture. See the [verification record](../../docs/validation.md) for commands, chronology, and remaining accuracy/capacity limits.
