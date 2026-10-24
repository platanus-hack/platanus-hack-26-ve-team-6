#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const composeText = await readFile(new URL('../infra/compose.yaml', import.meta.url), 'utf8');
const dockerfileText = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
const configText = readFileSync(0, 'utf8');
let compose;
try {
  compose = JSON.parse(configText);
} catch (error) {
  throw new Error('Read normalized Compose JSON from stdin (docker compose config --format json).', { cause: error });
}

const services = compose.services;
assert.ok(services && typeof services === 'object', 'Compose configuration must include services.');
const environment = (name) => {
  const values = services[name]?.environment;
  assert.ok(values && typeof values === 'object', `Compose service ${name} must define an environment.`);
  return values;
};
const requireValue = (condition, message) => assert.ok(condition, message);

for (const name of ['web', 'coordinator']) {
  const value = environment(name).GOTCHU_DEMO_ENABLED;
  requireValue(value === 'true' || value === 'false', `${name} must receive an explicit boolean GOTCHU_DEMO_ENABLED value.`);
}
requireValue(
  composeText.includes('GOTCHU_DEMO_ENABLED: ${GOTCHU_DEMO_ENABLED:-false}'),
  'GOTCHU_DEMO_ENABLED must default to false in Compose.',
);

const webEnvironment = environment('web');
for (const name of ['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'AUTH_OIDC_ISSUER', 'AUTH_OIDC_CLIENT_ID', 'AUTH_OIDC_CLIENT_SECRET', 'AUTH_OIDC_NAME']) {
  requireValue(Object.hasOwn(webEnvironment, name), `web must accept optional ${name}.`);
  requireValue(!composeText.includes(`${name}: \${${name}:?`), `${name} must not be mandatory for local Compose.`);
}

const coordinatorEnvironment = environment('coordinator');
requireValue(Object.hasOwn(coordinatorEnvironment, 'GOTCHU_DEMO_TARGET_ORIGIN'), 'coordinator must accept an optional GOTCHU_DEMO_TARGET_ORIGIN override.');
requireValue(coordinatorEnvironment.GOTCHU_DEMO_TARGET_ORIGIN === null || typeof coordinatorEnvironment.GOTCHU_DEMO_TARGET_ORIGIN === 'string', 'coordinator target origin must be optional.');
requireValue(/^\s+GOTCHU_DEMO_TARGET_ORIGIN:\s*$/m.test(composeText), 'coordinator demo target origin must remain unset unless the operator supplies it.');
requireValue(coordinatorEnvironment.GOTCHU_CUSTOMER_DISCOVERY === 'true' || coordinatorEnvironment.GOTCHU_CUSTOMER_DISCOVERY === 'false', 'coordinator customer discovery must be an explicit boolean.');
requireValue(composeText.includes('GOTCHU_CUSTOMER_DISCOVERY: ${GOTCHU_CUSTOMER_DISCOVERY:-false}'), 'coordinator customer discovery must default to disabled outside the self-host profile.');

for (const [name, service] of Object.entries(services)) {
  for (const port of service.ports ?? []) {
    requireValue(Number(port.target) !== 4100, `${name} must not publish the private demo target port 4100.`);
  }
}
requireValue(Object.hasOwn(webEnvironment, 'GOTCHU_API_DATABASE_URL') && Object.hasOwn(webEnvironment, 'GOTCHU_INGEST_DATABASE_URL'), 'web database runtime roles must remain separate.');
requireValue(Object.hasOwn(coordinatorEnvironment, 'GOTCHU_COORDINATOR_DATABASE_URL') && Object.hasOwn(coordinatorEnvironment, 'GOTCHU_REDIS_URL'), 'coordinator database and Redis runtime access must remain configured.');
requireValue((services.postgres.volumes ?? []).some(({ target }) => target === '/var/lib/postgresql/data'), 'Postgres data must retain its persistent volume.');
requireValue((services.redis.volumes ?? []).some(({ target }) => target === '/data'), 'Redis data must retain its persistent volume.');

for (const stage of ['web', 'coordinator']) {
  const marker = ` AS ${stage}\n`;
  const markerIndex = dockerfileText.indexOf(marker);
  requireValue(markerIndex >= 0, `Dockerfile must define the ${stage} runtime image.`);
  const contentStart = markerIndex + marker.length;
  const nextStage = dockerfileText.indexOf('\nFROM ', contentStart);
  const runtimeStage = dockerfileText.slice(contentStart, nextStage < 0 ? undefined : nextStage);
  for (const [sourceStage, path, description] of [
    [`${stage}-build`, 'package.json', 'manifest'],
    [`${stage}-build`, 'dist', 'built files'],
    [`${stage}-production-dependencies`, 'node_modules', 'production dependencies'],
  ]) {
    const copy = `COPY --from=${sourceStage} --chown=node:node /workspace/packages/triage/${path} /workspace/packages/triage/${path}`;
    requireValue(runtimeStage.includes(copy), `${stage} runtime image must include @gotchu/triage ${description}.`);
  }
}

process.stdout.write('Demo, identity, database, private-port, and runtime package image checks passed.\n');

const image = process.argv[2];
if (!image) {
  process.stdout.write('Pass a coordinator image name to also check its bundled assessment runtime.\n');
  process.exit(0);
}

const imageCheck = `
import assert from 'node:assert/strict';
import { createControlledAssessmentRunner, controlledTargetKey } from '@gotchu/assessment';
import { startDemoTargetServer } from '@gotchu/demo-target';
import { triageRevisionSchema } from '@gotchu/triage';

assert.equal(process.getuid?.(), 1000, 'coordinator image must run this check as the nonroot Node user');
const triageRevision = triageRevisionSchema.parse({
  id: 'runtime-package-smoke',
  revision: 1,
  previousRevisionId: null,
  rulesVersion: 'runtime-package-smoke',
  inputDigest: 'runtime-package-smoke',
  impact: {
    observed: 'unknown',
    affectedServices: [],
    window: { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' },
    checkedPoints: [],
    missingData: [],
  },
  hypotheses: [],
  unknownInvestigable: [],
});
assert.equal(triageRevision.id, 'runtime-package-smoke');
process.stdout.write('Runtime @gotchu/triage import and schema check passed.\\n');
assert.equal(triageRevisionSchema.safeParse({}).success, false, 'coordinator image must bundle its transitive @gotchu/triage runtime dependency');
const target = await startDemoTargetServer({ host: '127.0.0.1', port: 0 });
try {
  const runner = createControlledAssessmentRunner({ origin: target.origin });
  for (const revision of ['vulnerable', 'corrected']) {
    const report = await runner.run({
      organizationId: 'a0000000-0000-4000-8000-000000000001',
      applicationId: 'a0000000-0000-4000-8000-000000000002',
      jobId: 'a0000000-0000-4000-8000-000000000003',
      targetKey: controlledTargetKey,
      mode: 'both',
      revision,
    });
    assert.equal(report.internal?.status, 'completed', revision + ' bundled source/advisory assessment must complete');
    assert.equal(report.external?.status, 'completed', revision + ' loopback HTTP assessment must complete');
    assert.equal(report.responseMode, 'observation');
    assert.deepEqual(report.actionsPerformed, []);
  }
} finally {
  await target.close();
}
process.stdout.write('Bundled vulnerable/corrected assessment checks passed.\\n');
`;

const result = spawnSync('docker', [
  'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m',
  '--entrypoint', 'node', image, '--input-type=module', '-e', imageCheck,
], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
if (result.error) throw new Error(`Could not run coordinator image check: ${result.error.message}`, { cause: result.error });
if (result.status !== 0) {
  process.stderr.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  throw new Error(`Coordinator image check exited with status ${result.status ?? 'unknown'}.`);
}
process.stdout.write(result.stdout);
