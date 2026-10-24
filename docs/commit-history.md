# Commit history inventory

## Snapshot

This inventory covers every commit reachable from fixed HEAD `8c03aca79c9d60aa750f72818611131f86d55bfe`: **332 commits**, ordered by committer timestamp ascending in UTC, with parents first when timestamps tie. It contains one root commit and no merges. The current worktree was at this fixed HEAD when measurements began. The inventory docs added afterward are outside the measured snapshot and are recorded in the closing note below.

The 332 rows are split into chronological files of at most 120 commits:

- [Commits 1–111](commit-history-001.md): `9b1624f052b9` through `952e3c17f21b`.
- [Commits 112–222](commit-history-002.md): `906fda570933` through `950eebb1221f`.
- [Commits 223–332](commit-history-003.md): `df2d71385cba` through `8c03aca79c9d`.

Large changes and the recent milestone are summarized in [the outlier and milestone review](commit-history-outliers.md).

## Measurement rules

- Each commit is measured against its first parent. The root commit is compared with the empty Git tree. This captures merge resolution once while counting branch commits as their own commits; there are no merges in this snapshot.
- Diffs use Git numstat with rename detection disabled. `Files` counts changed paths, so a rename is represented as a deleted path plus an added path.
- `Raw + / − / total` gives added lines, deleted lines, and their sum. Binary files have no line count in numstat; they still count as files and appear in `Binary files`. No binary changes occur in this snapshot.
- `Authored + / − / total` uses the same line counts after excluding lockfiles, generated output, and fixture data. Totals are additions plus deletions, not net growth. The inventory counts every commit’s change event, so repeated edits to a line are counted repeatedly across history.
- Excluded paths are identified by these patterns:
  - **Lockfiles:** `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, and files ending in `.lock`.
  - **Generated output:** path segments `generated`, `gen`, `dist`, `build`, `coverage`, `.next`, `.turbo`, or `__generated__`; filenames matching `*.generated.*` or `*.gen.*`; and `apps/web/src/routeTree.gen.ts`.
  - **Fixture data:** path segments `fixture`, `fixtures`, `__fixtures__`, or `__snapshots__`, plus all of `apps/demo-target/**`, which the project instructions designate as a regression fixture.

## Measured totals

| Measure | Added | Deleted | Changed lines |
|---|---:|---:|---:|
| Raw | 51,778 | 3,044 | 54,822 |
| Authored after exclusions | 45,596 | 2,845 | 48,441 |

Thresholds are strict: **41** commits exceed 300 authored lines, **8** exceed 1,000 raw lines, and **5** exceed 1,000 authored lines. See the detailed outlier table; the inventory rows also flag every commit over these thresholds.

## Future commit discipline

Keep each focused commit near 300 authored changed lines or fewer, consistent with `AGENTS.md`. Split larger work by layer where that keeps each step coherent, and explain exceptional commits in their message body. The measured recent milestone contains 20 commits with a maximum of 288 raw and 288 authored changed lines; this is a measured result for that range, not a claim that the full history stayed below the target.

## Closing note

The ledger is fixed to `8c03aca79c9d60aa750f72818611131f86d55bfe` and is not recursively extended by its own commits. Ledger commits are recorded in the commit history after this baseline.
