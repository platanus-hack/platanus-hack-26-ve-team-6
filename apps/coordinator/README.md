# Trusted job coordinator

This process holds the coordinator database and Redis credentials. It bridges committed outbox IDs to BullMQ, verifies each queue envelope against persisted job intent, claims durable work, and groups signed application authentication failures into stable account/IP incidents. Event effects and job completion share a transaction. It never runs customer code or calls provider write adapters.

Assign up to five organizations through `GOTCHU_ORGANIZATION_IDS` for the private pilot. Runtime configuration requires `GOTCHU_COORDINATOR_DATABASE_URL` and `GOTCHU_REDIS_URL`; each database login belongs only to `gotchu_coordinator`. Empty assignment stays explicitly unready. `/health/live` and `/health/ready` use port 3003 by default.

Optional `GOTCHU_WORKER_URL` and `GOTCHU_RUN_CAPABILITY_PRIVATE_KEY` enable signed, scoped calls to the separate investigation process. HTTPS is required outside explicit loopback development/test. Without this configuration, investigation jobs and runs record unavailable states while deterministic processing continues. Model budgets and checkpoint writes are enforced by the trusted gateway. The agent never receives these database, Redis, or signing credentials.

The initial detector is five failures per ten-minute account or IP window; these are fixture defaults awaiting representative-traffic calibration. Processing caps a queried window at ten thousand events and records degradation instead of pretending the window was fully inspected. Other detectors, customer notification delivery, scanner profiles, and provider write adapters remain release gates. Unconfigured adapters fail visibly. Capacity and latency targets are not established by a successful unit test.
