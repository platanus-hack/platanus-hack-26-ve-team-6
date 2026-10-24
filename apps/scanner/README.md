# Scanner service (development)

Coordinator interface, exported by `@gotchu/scanner`:

```ts
interface ScannerClientOptions {
  origin: string;
  secret: Uint8Array; // 32–1024 bytes, held only by coordinator/scanner host
  timeoutMs?: number; // default 60,000; maximum 65,000
  allowDevelopmentHttp?: boolean; // explicit literal-loopback opt-in
}
const client = createScannerClient(options);
const report = await client.run(input); // CustomerRunInput -> Promise<CustomerAssessmentReport>
```

`input` is the exact persisted version 2 request returned by `backend.customers.getRequest`. No caller URLs or scanner options are added. The client validates both runtime contracts and exact report scope/subject binding. Coordinator persistence must still revalidate its durable lease, target authorization/version and source binding. TLS is verified by default. HTTP requires both `allowDevelopmentHttp: true` and `NODE_ENV=development|test`, and only canonical literal `127.0.0.1` or `[::1]` origins. Paths, credentials, queries, fragments and redirects are refused; no environment proxy is used.

`createScannerServer({ secret, runner? })` returns a Node HTTP server. `runner` implements `run(input): Promise<CustomerAssessmentReport>` and `readiness(): Promise<{ ready: boolean; tools: { name: string; available: boolean }[] }>`; the default is `createCustomerAssessmentRunner()`. The host has no DB/Redis access. It is a separate process called by the durable coordinator, not code inside a customer-facing route. No customer code is executed. The trusted host alone orchestrates fixed parser containers; scanner jobs receive no service secret or Docker socket.

## Local process configuration

`NODE_ENV=development pnpm --filter @gotchu/scanner start` runs the built `dist/main.js`, binds only `127.0.0.1`, and logs its PID/port. Required `GOTCHU_SCANNER_SECRET_FILE` names a local credential file containing the raw shared bytes (no trimming/base64 decoding). `GOTCHU_SCANNER_PORT` defaults to 4400. Set `GOTCHU_SCANNER_OSV=1` to explicitly enable the bounded package-name/version-only OSV adapter. Without it, advisory coverage is unavailable and aggregate readiness is unready. No secret is printed, placed in process arguments or inherited by child jobs. Keep the credential file out of version control. SIGINT/SIGTERM stop accepting work and allow active bounded requests to finish.

The parent development launcher can import `createScannerServer` directly to share an in-memory secret instead. For separate processes, provision a private temporary file and supply the same raw bytes to `createScannerClient`. Parent owns process/PID/port records and credential-file cleanup. Production TLS hosting is not implemented by this local entry point; the client supports verified HTTPS and `createScannerServer` can sit behind an operator-controlled TLS terminator.

## Wire contract and bounds

`POST /v1/assessments`, `Content-Type: application/json`, `x-gotchu-timestamp` as decimal Unix seconds and `x-gotchu-signature` as 64 lowercase HMAC-SHA256 hex characters. The signing bytes are UTF-8 `gotchu-scanner-v1\n${timestamp}\n` followed by the exact raw body bytes. `signScannerBody` and `verifyScannerSignature` are exported. Timestamp window is ±60 seconds; comparison is constant-time. Repeated signatures are rejected for their full validity window by a bounded in-memory map. This is process-local replay protection, not durable exactly-once execution; the backend job/lease/report transaction remains authoritative after restarts.

One active intake/run per service, no waiting queue, at most 16 connections. Intake deadline five seconds, raw header cap 8 KiB, signed request cap 4,500,000 bytes (shared source snapshot cap is 4 MiB), result cap from `CUSTOMER_MAX_REPORT_BYTES` (1 MiB), service response deadline 55 seconds (client/gateway reads remain 60 seconds). The default core deadline is 55 seconds. Client result buffering is streaming-capped. HTTP errors contain stable codes only, never source, credentials, raw parser output or exception details. Busy returns 429, replay 409, signature rejection 401, invalid input 400 and unavailable execution 503. A timed-out runner retains the admission slot until all its operations and cleanup actually settle. A cleanup fault latches readiness and admission unavailable until operator reconciliation and supervisor restart; it never produces a success report.

`GET /readyz` returns 200 only when the actual pinned parser profile self-tests and configured advisory readiness succeed; otherwise 503 with per-tool availability. Concurrent probes share one aggregate readiness operation and a 30-second result cache. Readiness uses the same admission slot as assessments, responds within 40 seconds, and retains that slot if the underlying probe hangs. See [engine profiles and sandbox limits](../../packages/customer-assessment/README.md). Missing tools are not green readiness and do not produce invented clean reports.

## Checks

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/customer-assessment build
pnpm --filter @gotchu/scanner build
pnpm --filter @gotchu/scanner typecheck
pnpm --filter @gotchu/scanner test
```

Service tests use real HTTP sockets with an explicitly injected unavailable-scanner runner: they test authentication, replay, request/result caps, deadlines, one-run admission, redirects and report-binding rejection. They are not scanner accuracy tests. The engine's `test:live` runs real Docker profiles and OSV; its HTTPS tests use actual TLS sockets with a test CA. No AWS resources, cloud deployment, production credentials, customer execution or provider writes are involved.
