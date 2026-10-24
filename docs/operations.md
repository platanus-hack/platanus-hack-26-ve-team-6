# Monitoring, alerts and correction preparation

The private customer dashboard has a **Vigilancia** page. Select an application, configure its inputs, inspect coverage, review alerts, and prepare an appropriate next step. Reports also offer evidence-bound correction options. These flows work in development; no cloud deployment is required.

## Choose what is inspected

- **Source:** an uploaded immutable snapshot or an operator-approved repository. GitHub reads resolve the configured ref and read files at the exact resulting commit. Local Git reads a managed bare repository; its owner must update that repository's refs. Gotchu does not execute hooks, package scripts, builds or tests.
- **Dependencies:** supported exact npm package-lock versions are queried against OSV again on each scheduled repository read, including unchanged commits. This is advisory metadata analysis, not an audit of every dependency's source repository or proof that a vulnerable function is reachable.
- **Public surface:** separately verify each authorized HTTPS origin by DNS TXT. Root consent permits one root GET. Explicit `public_surface` consent permits at most ten GETs, bounded static paths and same-origin discoveries, with DNS/TLS/scope/expiry checks on every request. Query crawling, cross-origin discovery, redirects, credentials and exploitation are excluded. Caps and unavailable paths remain visible coverage gaps.
- **Provider context:** select Cloudflare, Railway or both. Their status feeds can report an upstream outage; impact on this application stays unverified until independent application evidence exists.
- **Runtime:** connect signed application telemetry in the dashboard. The generated signing key is shown once. Use the Node SDK from the application's trusted server; never put the key in client JavaScript. Rotate or disable it from the same page.

The development launcher enables the scheduler. Other coordinator starts require `GOTCHU_MONITORING_ENABLED=true`; `GOTCHU_MONITORING_OSV=true` enables repository advisory lookup. The default dashboard interval is six hours. Scheduling is periodic, not a real-time guarantee or a Git webhook integration. Signed accepted events have a separate deterministic delivery lane from audits, investigations and report-alert projection.

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

## Bounds and gaps

Each app admits three unfinished assessments; each workspace admits twenty per rolling day. Scheduled checks share these limits with manual and correction rescans. Sources allow ten active snapshots/app and one hundred new snapshots/workspace/day. Monitoring retains at most 1,000 runs/app, 2,000 observations/app, 100 new observations/app/day and 100 plans/app. Retention maintenance is operator work; there is no indefinite retention or unlimited monitoring claim.

When alert storage is full, accepted event processing and mandatory authentication detection continue while operational projection becomes visibly degraded. Expired/archived assessment projections settle with explicit durable failure reasons rather than retrying forever or renewing old evidence. Existing reports remain readable. Review coverage and reconcile storage or incomplete work before treating the application as monitored.

The local signing credential store uses private filesystem files. Hosted encrypted secret storage, external notifications, production scanner upgrades, disposable VM isolation, MFA/provider execution and measured recovery remain release gates. The AWS infrastructure definition has not been deployed.
