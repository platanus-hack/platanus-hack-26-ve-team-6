# @gotchu/triage

A deterministic, framework-free domain core for a versioned scenario catalog, evidence correlation, immutable revision links, and a small labeled evaluation corpus. Runtime inputs are validated with bounded Zod schemas. `correlate` separates observed impact from multiple simultaneous hypotheses and records rule IDs and evidence references; `revise` returns a new revision linked to its predecessor.

The catalog's response options are guidance only and carry adapter identifiers. This package emits no actions, permission decisions, or executable recommendations. A provider status fixture remains labeled as a fixture. A provider feed does not prove customer impact, temporal coincidence does not prove causality, and confidence labels are ordinal rules, not calibrated probabilities. “No impact observed” applies only to checked points. Missing or stale data stays unknown.

Build with `pnpm --filter @gotchu/triage build`; typecheck and tests use the same filter. `eval` evaluates tuning and holdout partitions separately and writes the deterministic report to the ignored `.local/evaluation-report.json`. Holdout must not be used to tune rules; the corpus is synthetic, and its metrics are not production guarantees.
