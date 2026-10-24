#!/usr/bin/env bash
# Build in CI first; install only the production dependency closure in an isolated archive.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:?Provide an absolute output archive path}
[[ $output == /* ]] || exit 2
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cd "$root"
git archive HEAD | tar -x -C "$stage"
for directory in apps/*/dist packages/*/dist apps/web/.output; do
  [[ -d $directory ]] || continue
  cp -a "$directory" "$stage/$(dirname "$directory")/"
done
printf '{"commit":"%s","nodeMajor":24,"platform":"linux","arch":"x64"}\n' "$(git rev-parse HEAD)" >"$stage/release.json"
cd "$stage"
pnpm --filter '@gotchu/web...' --filter '@gotchu/coordinator...' --filter '@gotchu/scanner...' --filter '@gotchu/database...' \
  install --prod --frozen-lockfile --ignore-scripts
for service in web coordinator scanner; do
  (cd "apps/$service"; node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const { dependencies } = JSON.parse(await readFile('package.json', 'utf8'));
for (const name of Object.keys(dependencies).filter(name => name.startsWith('@gotchu/'))) {
  await import(name);
}
NODE
  )
done
tar -czf "$output" .
sha256sum "$output"
