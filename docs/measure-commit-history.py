#!/usr/bin/env python3
"""Measure first-parent numstat for a commit range using the ledger exclusions."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import subprocess
import sys


LOCKFILE_NAMES = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
}
LOCKFILE_SUFFIXES = (".lock",)
GENERATED_PATHS = (
    "apps/web/src/routeTree.gen.ts",
    "docs/triage-evaluation.json",
    "docs/triage-evaluation-holdout-repeat-v1.0.2.json",
    "docs/triage-evaluation.md",
)
VENDORED_PATHS = (
    "packages/customer-assessment/profiles/gitleaks.toml",
)
FIXTURE_PATHS = (
    "apps/demo-target/src/fixtures/**",
    "apps/validator/test/fixtures/node-regression/package.json",
    "apps/validator/test/fixtures/node-regression/src/feature.js",
    "packages/customer-assessment/test/fixtures/live-sca-project/**",
    "packages/customer-assessment/test/fixtures/schema/bom-1.5.schema.json",
)


def git(*args: str, input_data: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *args], check=True, input=input_data, stdout=subprocess.PIPE
    ).stdout


def is_excluded(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return (
        name in LOCKFILE_NAMES
        or name.endswith(LOCKFILE_SUFFIXES)
        or any(fnmatch.fnmatchcase(path, pattern) for pattern in GENERATED_PATHS)
        or any(fnmatch.fnmatchcase(path, pattern) for pattern in VENDORED_PATHS)
        or any(fnmatch.fnmatchcase(path, pattern) for pattern in FIXTURE_PATHS)
    )


def changed_paths(parent: str, commit: str) -> list[tuple[str, int | None, int | None]]:
    output = git("diff", "--numstat", "--no-renames", "-z", parent, commit)
    rows: list[tuple[str, int | None, int | None]] = []
    for record in output.decode("utf-8", errors="surrogateescape").split("\0"):
        if not record:
            continue
        added, deleted, path = record.split("\t", 2)
        if added == "-" or deleted == "-":
            rows.append((path, None, None))
        else:
            rows.append((path, int(added), int(deleted)))
    return rows


def measure(commit: str, order: int) -> dict[str, object]:
    metadata = git("show", "-s", "--format=%H%x00%ct%x00%P%x00%s", commit)
    full_sha, timestamp, parents, subject = metadata.decode().rstrip("\n").split("\0", 3)
    timestamp_seconds = int(timestamp)
    committer_time_utc = dt.datetime.fromtimestamp(
        timestamp_seconds, tz=dt.timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    parent_list = parents.split()
    if parent_list:
        parent = parent_list[0]
    else:
        parent = git("hash-object", "-t", "tree", "--stdin", input_data=b"").decode().strip()

    paths = changed_paths(parent, full_sha)
    raw_add = raw_del = auth_add = auth_del = binary_count = 0
    binaries: list[str] = []
    for path, added, deleted in paths:
        if added is None or deleted is None:
            binary_count += 1
            binaries.append(path)
            continue
        raw_add += added
        raw_del += deleted
        if not is_excluded(path):
            auth_add += added
            auth_del += deleted

    return {
        "order": order,
        "sha": full_sha,
        "short_sha": full_sha[:12],
        "timestamp": timestamp_seconds,
        "committer_time": committer_time_utc,
        "subject": subject,
        "files": len(paths),
        "raw_add": raw_add,
        "raw_del": raw_del,
        "raw_total": raw_add + raw_del,
        "authored_add": auth_add,
        "authored_del": auth_del,
        "authored_total": auth_add + auth_del,
        "binary_count": binary_count,
        "binary_files": binaries,
        "flags": [flag for flag, condition in (
            ("auth>300", auth_add + auth_del > 300),
        ) if condition],
    }


def total(rows: list[dict[str, object]], prefix: str) -> tuple[int, int, int]:
    added = sum(int(row[f"{prefix}_add"]) for row in rows)
    deleted = sum(int(row[f"{prefix}_del"]) for row in rows)
    return added, deleted, added + deleted


def markdown(rows: list[dict[str, object]], baseline: str, endpoint: str) -> str:
    result = [
        f"Range: `{baseline}..{endpoint}`; {len(rows)} commits.",
        "",
        "| UTC committer time | Commit | Subject | Files | Raw + / − / total | Authored + / − / total | Binary files | Flags |",
        "|---|---|---|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        raw = f"{row['raw_add']:,} / {row['raw_del']:,} / {row['raw_total']:,}"
        authored = f"{row['authored_add']:,} / {row['authored_del']:,} / {row['authored_total']:,}"
        flags = ", ".join(row["flags"]) or "—"
        subject = str(row["subject"]).replace("|", "\\|")
        result.append(
            f"| {row['committer_time'][:19].replace('T', ' ')} | `{row['short_sha']}` | {subject} | "
            f"{row['files']} | {raw} | {authored} | {row['binary_count']} | {flags} |"
        )
    return "\n".join(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", help="exclusive baseline commit")
    parser.add_argument("endpoint", help="inclusive endpoint commit")
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    args = parser.parse_args()

    commits = git("rev-list", "--reverse", "--topo-order", f"{args.baseline}..{args.endpoint}")
    ordered_commits = [line.decode() for line in commits.splitlines()]
    measured = [measure(commit, index) for index, commit in enumerate(ordered_commits)]
    # Topological order breaks timestamp ties while preserving parent-before-child order.
    measured.sort(key=lambda row: (int(row["timestamp"]), int(row["order"])))

    if args.format == "json":
        print(json.dumps({
            "baseline": args.baseline,
            "endpoint": args.endpoint,
            "commit_count": len(measured),
            "raw": total(measured, "raw"),
            "authored": total(measured, "authored"),
            "over_300_authored": sum(int(row["authored_total"]) > 300 for row in measured),
            "over_1000_raw": sum(int(row["raw_total"]) > 1000 for row in measured),
            "over_1000_authored": sum(int(row["authored_total"]) > 1000 for row in measured),
            "commits": measured,
        }, indent=2))
    else:
        print(markdown(measured, args.baseline, args.endpoint))
        raw = total(measured, "raw")
        authored = total(measured, "authored")
        print(
            f"\nSummary: {len(measured)} commits; raw {raw[0]:,}/{raw[1]:,}/{raw[2]:,}; "
            f"authored {authored[0]:,}/{authored[1]:,}/{authored[2]:,}; "
            f">300 authored {sum(int(row['authored_total']) > 300 for row in measured)}; "
            f">1,000 raw {sum(int(row['raw_total']) > 1000 for row in measured)}; "
            f">1,000 authored {sum(int(row['authored_total']) > 1000 for row in measured)}"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"git command failed: {error}", file=sys.stderr)
        raise SystemExit(error.returncode)
