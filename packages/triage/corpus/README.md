# Correlation evaluation corpus

Corpus `1.0.0` contains authored ground truth in `cases.ts`; labels were recorded before running the rules. `tuning/` and `holdout/` are separate partitions; changes to thresholds and rules must use tuning cases only. Never tune against holdout results. Add new, independently labeled holdout cases before relying on a score.

The report is reproducible with `pnpm --filter @gotchu/triage eval`. Precision/recall are micro-averaged over the five hypothesis kinds within each scenario. A false alarm is a predicted supported cause absent from that case's labels. Abstention counts cases with no supported cause. Confidence errors are counted only where a case has an explicit expected ordinal confidence; the denominator is shown.

Acceptance thresholds are targets for future evaluation, not measured production guarantees: no supported provider cause from global-only status; stale evidence always yields unknown impact; no false provider attribution on healthy independent control routes; and high confidence only after multiple independent compatible signals. This corpus is small and synthetic and does not establish calibration, causality, production quality, or time-to-decision.
