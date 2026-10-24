# Monitoring, alerts and correction preparation

The private customer dashboard has a **Vigilancia** page. Select an application, configure its inputs, inspect coverage, review alerts, and prepare an appropriate next step. Reports also offer evidence-bound correction options. These flows work in development; no cloud deployment is required.

## Choose what is inspected

- **Source:** an uploaded immutable snapshot or an operator-approved repository. GitHub reads resolve the configured ref and read files at the exact resulting commit. Local Git reads a managed bare repository; its owner must update that repository's refs. Gotchu does not execute hooks, package scripts, builds or tests.
- **Dependencies:** supported exact npm package-lock versions are queried against OSV again on each scheduled repository read, including unchanged commits. This is advisory metadata analysis, not an audit of every dependency's source repository or proof that a vulnerable function is reachable.
- **Public surface:** separately verify each authorized HTTPS origin by DNS TXT. Root consent permits one root GET. Explicit `public_surface` consent permits at most ten GETs, bounded static paths and same-origin discoveries, with DNS/TLS/scope/expiry checks on every request. Query crawling, cross-origin discovery, redirects, credentials and exploitation are excluded. Caps and unavailable paths remain visible coverage gaps.
- **Provider context:** select Cloudflare, Railway or both. Their status feeds can report an upstream outage; impact on this application stays unverified until independent application evidence exists.
- **Runtime:** connect signed application telemetry in the dashboard. The generated signing key is shown once. Use the Node SDK from the application's trusted server; never put the key in client JavaScript. Rotate or disable it from the same page.

The development launcher enables the scheduler. Other coordinator starts require `GOTCHU_MONITORING_ENABLED=true`; `GOTCHU_MONITORING_OSV=true` enables repository advisory lookup. The default dashboard interval is six hours. Scheduling is periodic, not a real-time guarantee or a Git webhook integration. Signed accepted events have a separate deterministic delivery lane from audits, investigations and report-alert projection.

## Vigilancia y notificaciones externas

The Vigilancia page shows **Vigilancia detenida** with a reason and start time when three scheduled checks finish degraded, a run lease expires, the coordinator heartbeat is older than 30 seconds, or a check misses its due time by two configured intervals. Liveness and per-application check heartbeats are stored in Postgres. A successful scheduled check clears the stopped state and records recovery. The dashboard also derives a stale coordinator state from the persisted heartbeat while the coordinator process is unavailable; without a separately deployed watchdog, an email or webhook cannot be sent until a coordinator is running again.

Owners and operators can add up to 20 workspace channels, set a minimum severity, send a queued test, inspect recent delivery states and disable a channel. High/critical scheduled findings, runtime detector alerts and monitoring stop/recovery transitions create durable notification events in the same Postgres transaction as their source evidence. Postgres outbox rows wake a background coordinator worker; HTTP requests never send notifications. Transient failures retry up to five attempts with bounded backoff. Permanent failures and exhausted retries appear as **Falló y quedó en revisión**. The stable idempotency key is sent on webhooks and as the email Message-ID/header, so webhook receivers should deduplicate by that key. Delivery is at least once; neither Gotchu nor SMTP can guarantee that a human read the message.

Email uses the coordinator's replaceable SMTP adapter. Configure `GOTCHU_SMTP_URL` (`smtp://` for STARTTLS or `smtps://` for implicit TLS), `GOTCHU_SMTP_FROM`, and optionally `GOTCHU_SMTP_TLS_MODE`; credentials can be embedded in the SMTP URL. A local SMTP such as Mailpit works for development. Production rejects plaintext SMTP. Email is accepted only when the SMTP server returns success; delivery beyond that server is outside Gotchu's visibility.

Webhook channels accept HTTPS URLs without credentials, query strings or fragments. Creation and every send resolve DNS and reject the destination if any answer is private, loopback, link-local, reserved or metadata-related; sends pin a validated address, use TLS hostname validation, time out after five seconds and refuse redirects. Gotchu sends `X-Gotchu-Timestamp` (Unix seconds), `X-Gotchu-Signature: sha256=<hex HMAC-SHA256>` over `<timestamp>.<raw JSON body>`, and `X-Gotchu-Idempotency-Key`. The base64url signing secret is shown once at channel creation. Receivers must verify the HMAC in constant time and reject timestamps more than five minutes from their clock. Secret files use owner-only permissions; API and coordinator must share `GOTCHU_NOTIFICATION_SECRET_DIRECTORY`. A managed encrypted secret store can replace the local adapter.

The real-service suite uses isolated Postgres and Redis containers, a local TLS webhook receiver that checks signatures and replay windows, and disposable Mailpit SMTP. Run `pnpm --filter @gotchu/coordinator test:live`; this is integration evidence for those fixtures, not a production availability or external provider guarantee.

## Operator repository registration

Set `GOTCHU_MONITORING_CONFIG_FILE` to an absolute regular JSON file before `pnpm dev:start`. Both the web catalog projection and coordinator reload this file on demand. Example shape:

```json
{
  "repositoryRoot": "/operator/managed/repos",
  "repositories": [{
    "organizationId": "11111111-1111-4111-8111-111111111111",
    "applicationId": "22222222-2222-4222-8222-222222222222",
    "repositoryKey": "company-product",
    "displayName": "Company product",
    "provider": "local_git",
    "path": "company/product.git",
    "ref": "refs/heads/main"
  }]
}
```

Use the real workspace/application IDs. A GitHub entry instead uses `provider: "github"`, `owner`, `repository`, optional `ref`, and an optional operator-only `tokenFile` for private access. The token file must be regular, nonsymlink and owner-only. No repository token is accepted through customer HTTP, persisted in monitor configuration, or returned to the browser. Only configured keys and display names are exposed within the exact organization/application. Missing permissions are unavailable coverage, not a successful connection. See [adapter configuration and bounds](../packages/monitoring/README.md).

## Evidence and scenarios

Detection uses versioned, bounded rules and recipes selected by persisted evidence and literal project configuration. The system does not generate arbitrary executable commands from an alert or model response. Current runtime rules cover measured 5xx/error categories, latency or capacity pressure, resource saturation, repeated authentication failures/password spraying, route enumeration, unexpected privilege changes and application-reported WAF matches. Thresholds are pilot defaults that need representative traffic calibration. No rule claims comprehensive coverage of common attacks.

Each alert shows severity, confidence, origin, checksums, collection time and freshness. Acknowledging/resolving it records customer triage; it does not independently verify a fix. Missing telemetry and stale or partial inputs remain limitations. External notification delivery, responders and escalation are not implemented by the in-app alert list.

## Buttons and their effects

| Control | Actual effect |
| --- | --- |
| Prepare a supported correction | Binds the exact report/finding/source digest and versioned recipe, stores a private candidate snapshot, and queues an independent internal rescan atomically. The original snapshot and repository are unchanged. |
| Review other correction options | Shows evidence-based risks, requirements and alternatives. Secrets need issuer rotation; dependency updates need a verified fixed release and lockfile handling. Neither is replaced by a guessed edit. |
| Investigate capacity | Requires measured error, latency or utilization pressure. Prepares an investigation/validation plan; it does not assume a load balancer addresses code, database or abuse problems. |
| Prepare migration | Creates a revision/hash-bound inventory, data, secrets, destination, cost, health, rollback and cutover checklist based on upstream context. Customer checklist entries are self-reported. |
| Check readiness | Returns the exact missing evidence and integration requirements. It cannot grant itself execution permission. |
| Execute in production | Disabled. Trusted MFA, provider adapters, independently verified preflight, exact approval, recovery and deployment gates are not established. |

No customer behavior tests are run. A successful targeted rescan is distinct from behavioral correctness or production readiness. Source deletion can make future correction preparation unavailable while historical reports remain readable. Unknown scanner outcomes remain quarantined for operator reconciliation.

## Retention, bounds and gaps

Workspace Owners can set age-based retention in the dashboard's **Retención** page. Defaults are 90 days for source snapshots, 30 for container images, 365 for reports, 30 for observations and runs, 90 for notification deliveries, and 30 for runtime protection events. The independent coordinator claims durable Postgres purge schedules every 30 seconds, processes up to 500 expired records per category and application, and continues a backlog after ten minutes. Active or reconciliation-required work keeps its source available. Purged source and image bodies are cleared while their small identity rows remain to preserve request references. Expired customer and controlled-assessment reports, observations and dependent alerts, completed runs, old deliveries, and protection events are deleted. Retention policy changes and count-only purge results are audited; source content is not copied into the purge job or audit record.

Retention is based on age; it does not guarantee capacity below every count quota during a traffic burst. Each app admits three unfinished assessments; each workspace admits twenty per rolling day. Scheduled checks share these limits with manual and correction rescans. Sources allow ten active snapshots/app and one hundred new snapshots/workspace/day. Monitoring still has finite limits of 1,000 runs/app, 2,000 observations/app, 100 new observations/app/day and 100 plans/app. Showing quota consumption and degradation in the UI and keeping every projection under those caps remain open. Permanent application/workspace deletion with a fresh Owner step-up is also not implemented.

When alert storage is full, accepted event processing and mandatory authentication detection continue while operational projection becomes visibly degraded. Expired/archived assessment projections settle with explicit durable failure reasons rather than retrying forever or renewing old evidence. Reports remain readable until their workspace retention age expires. Review coverage and reconcile storage or incomplete work before treating the application as monitored.

The local signing credential and notification-secret stores use private filesystem files; hosted encrypted secret storage and a separately deployed coordinator watchdog remain release gates. Production scanner upgrades, disposable VM isolation, MFA/provider execution and measured recovery are also not established. The AWS infrastructure definition has not been deployed.
