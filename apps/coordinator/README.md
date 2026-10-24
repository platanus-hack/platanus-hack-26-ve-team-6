# Trusted job coordinator

This process holds the coordinator database and Redis credentials. It bridges committed outbox IDs to BullMQ, verifies each queue envelope against persisted job intent, claims durable work, and groups signed application authentication failures into stable account/IP incidents. Event effects and job completion share a transaction. It never runs customer code or calls provider write adapters.

Assign up to five organizations through `GOTCHU_ORGANIZATION_IDS` for the private pilot. Runtime configuration requires `GOTCHU_COORDINATOR_DATABASE_URL` and `GOTCHU_REDIS_URL`; each database login belongs only to `gotchu_coordinator`. Empty assignment stays explicitly unready. `/health/live` and `/health/ready` use port 3003 by default.

Optional `GOTCHU_WORKER_URL` and `GOTCHU_RUN_CAPABILITY_PRIVATE_KEY` enable signed, scoped calls to the separate investigation process. HTTPS is required outside explicit loopback development/test. Without this configuration, investigation jobs and runs record unavailable states while deterministic processing continues. The trusted gateway enforces durable read counts and checkpoint authorization. Model calls stay disabled until the provider adapter enforces authoritative per-run token/spend accounting. The agent never receives these database, Redis, or signing credentials.

The initial detector is five failures per ten-minute account or IP window; these are fixture defaults awaiting representative-traffic calibration. Processing caps a queried window at ten thousand events and records degradation instead of pretending the window was fully inspected. Other detectors, customer notification delivery, scanner profiles, and provider write adapters remain release gates. Unconfigured adapters fail visibly. Capacity and latency targets are not established by a successful unit test.

Postgres remains the delivery authority after Redis loss or retry exhaustion. Reconciliation recreates eligible transport records, while investigations with unsettled provider reservations require reconciliation rather than another model call. A terminal scoped checkpoint can complete a recovered job even after its original run deadline, provided the current job lease is valid and no reservation remains. Run and job finalization share one transaction.

Recovery selects up to 100 eligible jobs per lane, visiting deterministic work first. An investigation backlog cannot consume the entire event-recovery batch.

BullMQ uses `gotchu-deterministic-v1` with one worker slot and `gotchu-investigations-v1` with two independent worker slots per coordinator. Slow investigation HTTP calls cannot consume the deterministic slot. Both outbox publication and reconciliation route by job kind through `createCoordinatorTransport`; unsupported adapters still fail explicitly. Shutdown stops dispatch, drains both workers, and closes both queues and all owned Redis clients before the database.

When upgrading from the shared `gotchu-jobs-v1` queue, stop the old coordinator before starting this version. Postgres reconciliation republishes unfinished jobs into their new lane, including already-delivered outbox intent, once any current durable lease expires. Old Redis records are not executable authority. These slot limits are per coordinator process, not a measured throughput or latency guarantee.

New events reject year-zero timestamps. Older incompatible timestamps remain stored but are excluded from detector windows using a guarded PostgreSQL conversion; coverage stays degraded while those rows remain. Aggregation serializes each application's window reads and writes to prevent an older snapshot from reducing incident counts.
