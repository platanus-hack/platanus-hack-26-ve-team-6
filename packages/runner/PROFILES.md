# Runner profile maintenance research

This is a version and validation proposal only. It does not change `@gotchu/customer-assessment`, enable production Semgrep readiness, or claim that the replacement has passed corpus validation.

## Semgrep CE candidate

| Field | Candidate |
| --- | --- |
| Upstream release | Semgrep CE `1.179.0` (released 2026-10-01) |
| OCI image | `docker.io/semgrep/semgrep:1.179.0` |
| OCI index | `sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b` |
| Linux amd64 manifest | `sha256:cab19964e6c93019934252a9cd591d9b27df1e5b5d1734b26f4069ae51c295f8` |
| Engine license | LGPL-2.1-only, as stated for Community Edition by Semgrep |
| Production status | Closed; no corpus validation or scanner integration was performed |

The upstream release page lists `1.179.0` as the current release; the CE product page describes the engine as open source under LGPL 2.1. The published image digest is pinned in [images.lock.json](./images.lock.json). Rules can carry separate licensing terms, so rule-source provenance and terms must be reviewed independently before adoption.

Sources: [Semgrep releases](https://github.com/semgrep/semgrep/releases), [Semgrep Community Edition](https://semgrep.dev/products/community-edition), [official Semgrep image tags](https://hub.docker.com/r/semgrep/semgrep/tags).

## Required validation before replacing 1.90.0

1. Freeze an owned, versioned corpus of representative JS/TS, YAML, JSON and unsupported inputs. Keep a disjoint holdout set and record source commit, fixtures, ruleset digests and expected findings.
2. Run the old and candidate engines against the same corpus in the disposable runner. Compare finding identities, locations, severities, coverage and exit behavior; label expected rule-set changes separately from regressions.
3. Include positive and negative controls, malformed inputs, oversized files, generated/vendor trees, parser failures and rules that intentionally have no match.
4. Measure wall time, peak guest memory, disk and output under the production profile limits. A timeout or partial parse must remain unavailable coverage, not a clean scan.
5. Pin the exact image manifest and rule bundle, execute with network denied, validate parsed output against the scanner contract, and repeat runs to check determinism.
6. Require security review of the image/license/rule terms and corpus results. Only then may a separate scanner change propose a production gate update.

Gitleaks and Trivy profiles need the same version, image-digest, rule/database and update-policy review. Their current pins and readiness remain governed by `@gotchu/customer-assessment`; this research does not modify them.
