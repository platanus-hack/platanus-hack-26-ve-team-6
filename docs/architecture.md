# Gotchu architecture: foundation status

Gotchu currently has a backend and infrastructure foundation. The code includes a TanStack Start HTTP adapter, an Auth.js Core integration, a separate backend domain package, Postgres persistence with a transactional outbox, a BullMQ coordinator, an isolated LangGraph HTTP worker, a run-capability gateway, and an independent executor ledger.

These components do not make Gotchu a completed or production-ready security product. Hosted model calls return `503` until a provider adapter exists; provider writes are frozen. Production MFA and trusted approval verifiers, cloud connectors, scanner services, customer-code execution, a production TLS deployment, restore evidence, and capacity evidence are not available.

## Service boundaries and request flow

```mermaid
flowchart LR
  subgraph clients[Clients]
    owner[Owner browser]
    sdk[Node event SDK]
  end

  subgraph web[Web process · TanStack Start]
    routes[HTTP routes and API adapter]
    auth[Auth.js Core HTTP bridge]
  end

  subgraph domain[Framework-independent domain]
    backend[@gotchu/backend]
    contracts[@gotchu/contracts]
    database[@gotchu/database]
  end

  subgraph durable[Durable job path]
    pg[(Postgres · source of truth)]
    coordinator[@gotchu/coordinator]
    queue[BullMQ on Redis · delivery transport]
  end

  subgraph investigation[Bounded investigation]
    worker[LangGraph HTTP worker<br/>no DB, Redis, provider key, or signing private key]
    gateway[Run-capability gateway<br/>TLS-capable · scoped reads · sanitized checkpoints]
    model[Hosted model provider adapter<br/>not configured]
  end

  subgraph execution[Independent execution boundary]
    executor[@gotchu/executor ledger]
    github[GitHub provider writes<br/>disabled]
  end

  owner -->|session request| routes
  routes --> auth
  routes --> backend
  sdk -->|HMAC-signed raw event batch| routes
  backend --> database
  database --> pg
  pg -->|committed job and outbox| coordinator
  coordinator -->|job ID| queue
  queue -->|at-least-once delivery| coordinator
  coordinator -->|claim and aggregate via domain| backend
  coordinator -->|short-lived signed run capability| worker
  worker -->|run-scoped HTTPS requests<br/>loopback HTTP only in dev/test| gateway
  gateway -->|authorized evidence reads and checkpoint writes| pg
  gateway -.->|503 · no call and no spend| model
  routes -.->|approval returns 503<br/>trusted step-up verifier absent| backend
  executor -->|separate runtime role and ledger| pg
  executor -.->|writes frozen| github
```

The diagram shows code boundaries and disabled edges. It does not imply that every adapter is configured or deployed. The coordinator’s durable work path currently handles event aggregation and investigation jobs; scan and notification adapters are not wired.

## Components

### TanStack Start and Auth.js Core

The web application hosts user and integration HTTP endpoints in TanStack Start server routes. A small server-side adapter calls Auth.js Core for `/api/auth/*`, validates the configured request origin, and uses JWT sessions. GitHub OAuth can be configured for sign-in. That sign-in is not a GitHub repository integration.

The route layer delegates to `@gotchu/backend`, keeping domain decisions out of route files. The backend derives organization access from stored membership and application relationships rather than trusting a client-supplied user or tenant header. Fresh second-factor approval is not implemented. The approval endpoint returns unavailable until a trusted step-up verifier is supplied.

### Domain and durable state

`@gotchu/contracts` owns runtime input schemas. `@gotchu/backend` owns event intake, authorization, job, proposal, approval, run, budget, and execution-ledger operations. `@gotchu/database` owns connection setup, runtime-role provisioning, migrations, and tenant-scoped transactions.

Postgres is authoritative for accepted events, job intent, outbox delivery state, incidents, proposals, run budgets and checkpoints, and executor ledger records. Runtime roles are separated for the web API, event intake, coordinator/gateway, and executor. A valid event batch and its outbox job are committed together before the API acknowledges the event.

The coordinator polls and leases committed outbox entries, enqueues job IDs in BullMQ, and reconciles missing, failed, or completed Redis deliveries against Postgres. Redis is transport, not the record of accepted work. Consumers claim durable jobs in Postgres and check the queue envelope against stored tenant and application scope before processing.

The event contract rejects year-zero timestamps before persistence. If legacy rows contain timestamps that PostgreSQL cannot parse, aggregation quarantines those rows from detector windows, retains the original events, and marks detection coverage degraded. This keeps malformed stored data from poisoning later valid event aggregation.

### Investigation worker and run gateway

The coordinator gives the worker a short-lived EdDSA run capability scoped to one organization, application, run, allowed read tools, and evidence IDs. The LangGraph worker exposes an HTTP endpoint and has no database connection, Redis connection, provider credential, or capability-signing private key. It receives only the public key needed to validate the capability and reaches input, reads, model calls, and checkpoint persistence through the gateway.

If a worker saved a validated terminal checkpoint and the coordinator stopped before finalizing the job, the next consumer can finalize that checkpoint using its current job lease. Recovery checks run and evidence scope and can settle the saved result even after the investigation deadline; it does not repeat the worker call.

The run gateway validates the capability and rechecks scope and budgets against Postgres. It stores bounded, sanitized checkpoints with optimistic versioning. It can serve HTTPS directly and fails closed on non-loopback plaintext outside development or test. Local HTTP/TLS fixtures exercise the transport, but there is no production certificate provisioning or deployed TLS path.

Investigation limits in the code cap a run at four model calls, eight additional read-tool calls, and five active minutes. The model operation is intentionally unavailable: without a configured provider adapter, requests return `503`; the live pipeline test expects the run to finish as unavailable with no model calls or spend. Deterministic event processing remains separate from model investigation.

### Proposals and executor ledger

The backend has typed proposal and approval contracts and persists exact action identity. Approval requires a trusted verifier for fresh second-factor proof; that production adapter is absent, so approval is unavailable. `@gotchu/executor` uses a separate narrow ledger role and can record/claim execution state. It has no enabled GitHub write adapter or provider credential. PR creation, merge, deployment, and other provider writes remain disabled.

### Local and cloud infrastructure

Docker Compose starts local Postgres and Redis. Web, coordinator, gateway, worker, executor, and scanner profiles are placeholders that fail closed until runnable container entrypoints and images are wired. The default Compose stack is not an application deployment.

The Pulumi TypeScript program defines a DigitalOcean VPC, firewalls, droplets, and a private Space. Its resource-policy tests use mocks. No DigitalOcean deployment has been made, and the program does not install the application services or provide a VM sandbox.

## Not available in this foundation

- Production MFA, trusted approval verification, and production integration-secret custody.
- GitHub repository access and write adapters, AWS coverage, Cloudflare telemetry, or other customer provider integrations.
- A model-provider adapter, model spend, or externally hosted investigation.
- Runnable scanner services for Semgrep, OSV-Scanner, Gitleaks, or Trivy.
- Customer dependency installation, customer tests, or any customer-code execution. The VM-class isolation gate is closed; containers are not a substitute.
- Production TLS termination/certificate management for the worker and run gateway.
- Cloud deployment, tested backup restoration, measured capacity, verified recovery objectives, or measured operating cost.

These are release gates, not capabilities implied by interface types, mocks, local fixtures, or the historical product decisions in the [definition interview](definition-interview.md).
