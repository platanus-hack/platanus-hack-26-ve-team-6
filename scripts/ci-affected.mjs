#!/usr/bin/env node
// Decides which CI work a change needs: changed workspace packages plus every package that depends on them.
// Usage: node scripts/ci-affected.mjs <base-sha> [head-sha]. Without a usable base, everything runs.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const [base, head = 'HEAD'] = process.argv.slice(2);

const packageDirs = [
  ...['apps', 'packages'].flatMap(parent => readdirSync(join(root, parent)).map(name => `${parent}/${name}`)),
  'infra/pulumi',
].filter(dir => existsSync(join(root, dir, 'package.json')));
const manifests = new Map(packageDirs.map(dir => [dir, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))]));
const nameByDir = new Map([...manifests].map(([dir, manifest]) => [dir, manifest.name]));
const dependents = new Map();
for (const manifest of manifests.values()) {
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  for (const [dependency, range] of Object.entries(deps)) {
    if (!String(range).startsWith('workspace:')) continue;
    if (!dependents.has(dependency)) dependents.set(dependency, new Set());
    dependents.get(dependency).add(manifest.name);
  }
}

// Files that change how everything installs, builds or runs.
const globalFiles = [/^\.github\//, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^package\.json$/, /^tsconfig\.base\.json$/, /^\.npmrc$/];
// Files that never affect a check.
const ignoredFiles = [/^docs\//, /\.md$/, /^skills-lock\.json$/, /^\.gitignore$/, /^\.impeccable\//, /^\.hermes\//];
const integrationFiles = [/^test\//, /^vitest\.integration\.config\.ts$/];
const installerFiles = [/^gotchu$/, /^scripts\/gotchu/, /^scripts\/infra-scanner-probe\.mjs$/];
const infraFiles = [/^infra\/(?!pulumi\/)/, /^Dockerfile$/, /^\.dockerignore$/, /^scripts\/infra-/];
const trivyFiles = [/^scripts\/update-trivy-db\.mjs$/];
// Styles and static assets only need their own package's build and tests, never the live stacks.
const styleFiles = [/\.(css|svg|png|jpe?g|webp|ico|woff2?)$/];

function changedFiles() {
  if (!base || /^0+$/.test(base)) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { return null; }
}

const files = changedFiles();
const matches = (patterns, file) => patterns.some(pattern => pattern.test(file));
let full = files === null;
const changedPackages = new Set();
const styledPackages = new Set();
const flags = { integration: false, installer: false, infra: false, trivy: false };
for (const file of files ?? []) {
  if (matches(ignoredFiles, file)) continue;
  if (matches(globalFiles, file)) { full = true; continue; }
  const dir = packageDirs.find(candidate => file.startsWith(`${candidate}/`));
  if (dir) { (matches(styleFiles, file) ? styledPackages : changedPackages).add(nameByDir.get(dir)); continue; }
  if (matches(integrationFiles, file)) { flags.integration = true; continue; }
  if (matches(installerFiles, file)) { flags.installer = true; continue; }
  if (matches(infraFiles, file)) { flags.infra = true; continue; }
  if (matches(trivyFiles, file)) { flags.trivy = true; continue; }
  full = true; // An unknown root file: run everything rather than guess.
}

const affected = new Set(full ? nameByDir.values() : []);
const pending = [...changedPackages];
while (pending.length) {
  const name = pending.pop();
  if (affected.has(name)) continue;
  affected.add(name);
  pending.push(...(dependents.get(name) ?? []));
}
const has = name => affected.has(name);
// The root manifest devDepends on every package the integration stack imports; it also runs the built web app.
const integrationPackages = new Set([...Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies ?? {}), '@gotchu/web']);

const outputs = {
  full,
  packages: [...new Set([...affected, ...styledPackages])].sort().map(name => `--filter=${name}`).join(' '),
  unit: affected.size > 0 || styledPackages.size > 0,
  postgres_database: has('@gotchu/database') || has('@gotchu/backend') || has('@gotchu/web'),
  postgres_gateway: has('@gotchu/gateway'),
  postgres_executor: has('@gotchu/executor'),
  coordinator_live: has('@gotchu/coordinator') || full || flags.trivy,
  integration: full || flags.integration || [...affected].some(name => integrationPackages.has(name)),
  installer: full || flags.installer,
  infra: full || flags.infra || has('@gotchu/web') || has('@gotchu/coordinator') || has('@gotchu/database'),
};
outputs.postgres = outputs.postgres_database || outputs.postgres_gateway || outputs.postgres_executor;
outputs.live = outputs.coordinator_live || outputs.integration;
outputs.verify = outputs.unit || outputs.integration || outputs.installer;

for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
