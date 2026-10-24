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
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
for (const service of ['web', 'coordinator', 'scanner']) {
  const require = createRequire(`${process.cwd()}/apps/${service}/package.json`);
  for (const name of Object.keys(require('./package.json').dependencies).filter(name => name.startsWith('@gotchu/'))) {
    await import(pathToFileURL(require.resolve(name)).href);
  }
}
NODE
tar -czf "$output" .
sha256sum "$output"
