# Real-app triage evaluation

Run 2026-10-24T18:26:19.385Z–2026-10-24T18:27:57.435Z; matrix 1.0.2 (13a449f228649abf6ed679e78be934b9b6d8a6fa7a70c3d280ec0ab41a4bc7b9); rules triage.rules.v1; commit 8fb44603be5ca7a65e8b5f8486529ee103082965; dirty worktree: true. Total runtime 98 s.

## Results

- **tuning:** 14 cases × 5 = 70 app/windows; alerts P/R 100.0%/100.0% (TP/predicted/actual 80/80/80); triage causes P/R 100.0%/100.0% (25/25/25); false alarms 0 across 70 windows (0.000 windows/app-window); abstention 55/70; confidence errors 0/85; impact errors 0/70; explicit unknown coverage 10/10; alert p50/p95 79/2354 ms (50/50 alert-bearing windows); triage p50/p95 225/2436 ms (70/70 windows); per-window runtime p50/p95 262/2464 ms (70/70 windows); fixed acceptance targets met: cases true, repetitions true, cause recall true, confidence error rate true, traffic control true, triage p95 true.
- **holdout:** 14 cases × 5 = 70 app/windows; alerts P/R 100.0%/98.8% (TP/predicted/actual 79/79/80); triage causes P/R 100.0%/100.0% (25/25/25); false alarms 0 across 70 windows (0.000 windows/app-window); abstention 55/70; confidence errors 1/85; impact errors 0/70; explicit unknown coverage 10/10; alert p50/p95 101/2570 ms (50/50 alert-bearing windows); triage p50/p95 228/2637 ms (70/70 windows); per-window runtime p50/p95 261/2664 ms (70/70 windows); fixed acceptance targets met: cases true, repetitions true, cause recall true, confidence error rate true, traffic control true, triage p95 true.

Per-scenario values use **TP/predicted/actual** for alert and triage cause precision/recall. False alarms are app/window counts; time values are p50/p95 milliseconds from injection. Confidence and impact denominators are shown.

| Split | Scenario | Alert P/R (TP/pred/actual) | Cause P/R (TP/pred/actual) | False-alarm windows | Abstain / windows | Confidence errors | Impact errors | Alert p50/p95 ms (n/positive) | Decision p50/p95 ms (n/windows) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tuning | bad-release-errors | 100.0%/100.0% (5/5/5) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | 65/81 (5/5) | 255/277 (5/5) |
| tuning | blocked-path-traversal-indication | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 52/88 (5/5) | 151/188 (5/5) |
| tuning | blocked-sqli-indication | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 40/68 (5/5) | 134/138 (5/5) |
| tuning | concurrent-faults | 100.0%/100.0% (25/25/25) | 100.0%/100.0% (10/10/10) | 0/10 | 10/10 | 0/20 | 0/10 | 152/269 (10/10) | 261/456 (10/10) |
| tuning | cpu-pressure | 100.0%/100.0% (10/10/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/10 | 0/5 | 157/160 (5/5) | 245/261 (5/5) |
| tuning | credential-stuffing | 100.0%/100.0% (10/10/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/0 | 0/5 | 42/74 (5/5) | 136/152 (5/5) |
| tuning | dependency-latency | 100.0%/100.0% (5/5/5) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | 2354/2359 (5/5) | 2444/2453 (5/5) |
| tuning | event-loop-pressure | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 2138/2195 (5/5) | 2220/2255 (5/5) |
| tuning | healthy-traffic-spike | n/a/n/a (0/0/0) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 144/164 (5/5) |
| tuning | memory-pressure | 100.0%/100.0% (10/10/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/10 | 0/5 | 46/50 (5/5) | 141/148 (5/5) |
| tuning | missing-telemetry | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 213/225 (5/5) |
| tuning | provider-outage-healthy-app | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 369/758 (5/5) |
| tuning | stale-telemetry | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 180/261 (5/5) |
| holdout | bad-release-errors | 100.0%/100.0% (5/5/5) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | 32/54 (5/5) | 111/117 (5/5) |
| holdout | blocked-path-traversal-indication | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 56/71 (5/5) | 228/297 (5/5) |
| holdout | blocked-sqli-indication | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 66/75 (5/5) | 222/260 (5/5) |
| holdout | concurrent-faults | 100.0%/100.0% (25/25/25) | 100.0%/100.0% (10/10/10) | 0/10 | 10/10 | 0/20 | 0/10 | 59/173 (10/10) | 153/330 (10/10) |
| holdout | cpu-pressure | 100.0%/90.0% (9/9/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 1/10 | 0/5 | 205/230 (5/5) | 354/398 (5/5) |
| holdout | credential-stuffing | 100.0%/100.0% (10/10/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/0 | 0/5 | 101/111 (5/5) | 240/266 (5/5) |
| holdout | dependency-latency | 100.0%/100.0% (5/5/5) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | 2570/2624 (5/5) | 2645/2691 (5/5) |
| holdout | event-loop-pressure | 100.0%/100.0% (5/5/5) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | 2174/2229 (5/5) | 2357/2417 (5/5) |
| holdout | healthy-traffic-spike | n/a/n/a (0/0/0) | 100.0%/100.0% (5/5/5) | 0/5 | 0/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 363/404 (5/5) |
| holdout | memory-pressure | 100.0%/100.0% (10/10/10) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/10 | 0/5 | 132/161 (5/5) | 272/303 (5/5) |
| holdout | missing-telemetry | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 120/130 (5/5) |
| holdout | provider-outage-healthy-app | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 120/136 (5/5) |
| holdout | stale-telemetry | n/a/n/a (0/0/0) | n/a/n/a (0/0/0) | 0/5 | 5/5 | 0/5 | 0/5 | n/a/n/a (0/0) | 145/181 (5/5) |

## Labelled mismatches

2 mismatches across all included splits (alert: 1, alert_confidence: 1). Full case IDs, repetitions, expected values, and observed values are in the JSON artifact.

## Tuning history and repeatability

The tuning history is retained to show why the measured detector and harness reached v1.0.2: v1.0.0 had 40 labelled mismatches (5 missed event-loop alerts, 10 unlabelled auth signals, 5 contradicted provider hypotheses, and 20 incorrect impact labels). After correcting the tuning labels and injection, v1.0.1 had no label mismatches but missed the fixed decision-latency target (p95 21,256 ms) and had 35/85 confidence errors. In v1.0.2 tuning, the bounded event-loop fault and detector-confidence correction yielded zero mismatches, 0/85 confidence errors, and 2,447 ms decision p95. No rule, label, or threshold changed after observing holdout; holdout misses remain unresolved. Two earlier holdout readings on the same frozen matrix are recorded separately in [triage-evaluation-holdout-repeat-v1.0.2.json](triage-evaluation-holdout-repeat-v1.0.2.json): the first missed event-loop pressure once (alert recall 79/80); the next missed the CPU resource signal in 3/5 repetitions (alert recall 77/80). This final combined run missed it in 1/5. Runs are not pooled.

## Safety and limits

- Provider status and target HTTPS probes are local fixtures; every upstream status is marked fixture. The target app and signed intake are real local HTTP processes, and event aggregation, alert projection, and triage revisions use disposable PostgreSQL/Redis plus the durable BullMQ coordinator path.
- The traffic-spike negative control is healthy load; it must not produce a runtime attack rule. SQL injection and path traversal are blocked before their local sinks, and the resulting events are indications only.
- Resource cases run in the local Node process. Memory utilization is measured against the bounded 64 MiB evaluation budget; these runs do not claim host-level or production capacity. Event-loop pressure is one bounded 1.05 s block.
- Stale/missing cases report unknown impact; blocked attack shapes do not establish exploitation. Severity and confidence are recorded as separate fields; exploitability is not established or represented by these paths. Provider execution readiness is checked as disabled.
- Deterministic rules only: 0 model calls and 0 tokens. No repair-time or production accuracy/capacity claim is made. Holdout labels were fixed in the versioned matrix before execution and were not used for tuning.

The full per-trial observations, denominators, timing samples, mismatches, and failures are in [triage-evaluation.json](triage-evaluation.json).
