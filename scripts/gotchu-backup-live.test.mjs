import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = join('/tmp', `gotchu-backup-live-${randomBytes(6).toString('hex')}`);
const stateDirectory = join(temporary, 'state');
const environmentFile = join(stateDirectory, '.env');
let backupFile = '';
const project = `gotchu-backup-live-${randomBytes(5).toString('hex')}`;
const passphrase = `local-backup-${randomBytes(16).toString('hex')}`;
const stateEnvironment = { ...process.env, GOTCHU_STATE_DIR: stateDirectory, GOTCHU_COMPOSE_PROJECT_NAME: project };
const composeFile = join(root, 'infra/compose.yaml');
const requireDatabase = createRequire(join(root, 'packages/database/package.json'));
const { Client } = requireDatabase('pg');
let environment = {};

function checked(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  return result.stdout.trim();
}

function compose(args, options = {}) {
  return checked('docker', ['compose', '-p', project, '--env-file', environmentFile, '-f', composeFile, ...args], { env: stateEnvironment, ...options });
}

function launchGotchu(args, responses) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const prompts = args[0] === 'backup'
    ? ['Frase de paso', 'Repite la frase de paso']
    : args[0] === 'restore' ? ['Frase de paso', 'Escribe RESTORE para continuar'] : ['Escribe RESET para continuar'];
  const child = spawn('script', ['-qec', `${quote(join(root, 'gotchu'))} ${args.map(quote).join(' ')}`, '/dev/null'], { cwd: root, env: stateEnvironment });
  return new Promise((resolve, reject) => {
    let output = '';
    let nextResponse = 0;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`./gotchu ${args[0]} timed out: ${output}`)); }, 180_000);
    const collect = chunk => {
      output += chunk.toString();
      while (nextResponse < prompts.length && output.includes(prompts[nextResponse] ?? '')) {
        child.stdin.write(`${responses[nextResponse]}\n`);
        nextResponse++;
        if (nextResponse === responses.length) child.stdin.end();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || nextResponse !== responses.length) reject(new Error(`./gotchu ${args[0]} failed: ${output}`));
      else resolve(output);
    });
  });
}

async function freePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  await Promise.all(servers.map(server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))));
  const ports = servers.map(server => String(server.address().port));
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

function parseEnv(text) {
  return new Map(text.split(/\r?\n/u).filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function databaseUrl(user, password) {
  const url = new URL(`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${environment.get('POSTGRES_HOST_PORT')}/${environment.get('POSTGRES_DB')}`);
  return url.toString();
}

function roleUrl(role) {
  const suffix = role.toUpperCase();
  const usernameKey = role === 'gotchu_gateway' ? 'GOTCHU_GATEWAY_DB_USERNAME' : `GOTCHU_${suffix.replace('GOTCHU_', '')}_DB_USERNAME`;
  const passwordKey = role === 'gotchu_gateway' ? 'GOTCHU_GATEWAY_DB_PASSWORD' : `GOTCHU_${suffix.replace('GOTCHU_', '')}_DB_PASSWORD`;
  return databaseUrl(environment.get(usernameKey), environment.get(passwordKey));
}

async function bootstrapDatabase() {
  compose(['up', '-d', 'postgres']);
  await waitForPostgres();
  checked('bash', ['scripts/infra-db-bootstrap.sh'], { env: { ...stateEnvironment, INFRA_ENV_FILE: environmentFile, INFRA_PROJECT_NAME: project, PATH: process.env.PATH } });
}

async function waitForPostgres() {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = spawnSync('docker', ['compose', '-p', project, '--env-file', environmentFile, '-f', composeFile, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', environment.get('POSTGRES_USER'), '-d', environment.get('POSTGRES_DB')], { cwd: root, stdio: 'ignore', env: stateEnvironment });
    if (result.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, 'isolated Postgres should become ready');
}

async function seedApprovedAction() {
  const [{ createDatabase, setRecoveryState }, { createBackend }] = await Promise.all([
    import(new URL('../packages/database/dist/index.js', import.meta.url)),
    import(new URL('../packages/backend/dist/index.js', import.meta.url)),
  ]);
  const bootstrapUrl = databaseUrl(environment.get('POSTGRES_USER'), environment.get('POSTGRES_PASSWORD'));
  await setRecoveryState({ connectionString: bootstrapUrl, mode: 'reconciled', reconciliationReference: 'Live backup test setup only' });
  const database = createDatabase({ connectionString: roleUrl('gotchu_api'), role: 'gotchu_api' });
  const identity = { userId: `backup-roundtrip:${randomUUID()}` };
  const now = new Date();
  const proposalVerifier = { verify: async proposal => ({
    policyVersion: proposal.policyVersion, currentBaseCommit: proposal.baseCommit, candidateCommit: proposal.candidateCommit,
    patchSha256: proposal.artifact.patchSha256, lockfileSha256: proposal.artifact.lockfileSha256,
    rescanAttestationId: proposal.validation.rescanAttestationId, suiteAttestationId: proposal.validation.suiteAttestationId,
    rescanPassed: true, suitePassed: true, suiteRelevant: true, vmIsolationVerified: true, repositoryAutomationSafe: true, observedAt: new Date(),
  }) };
  const stepUpVerifier = { verify: async value => ({ proofId: value.proof, userId: value.userId, organizationId: value.organizationId,
    actionHash: value.actionHash, authenticatedAt: now, expiresAt: new Date(now.getTime() + 240_000), method: 'webauthn' }) };
  const api = createBackend({ database, proposalVerifier, stepUpVerifier });
  try {
    const workspace = await api.customers.createWorkspace(identity, { name: `Backup ${randomUUID().slice(0, 8)}` });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Round trip application' });
    const proposal = {
      version: 1, organizationId: workspace.id, applicationId: application.applicationId, adapter: 'github.pull_request',
      target: { repository: 'local/roundtrip', branch: 'main' }, baseCommit: '1'.repeat(40), candidateCommit: '2'.repeat(40),
      changes: [{ name: 'roundtrip-package', from: '1.0.0', to: '1.0.1' }],
      artifact: { id: randomUUID(), patchSha256: 'a'.repeat(64), lockfileSha256: 'b'.repeat(64) },
      evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), tool: 'fixture', toolVersion: '1', observedAt: now.toISOString(), snapshotCommit: '1'.repeat(40) }],
      policyVersion: 'backup-test', validation: { rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID() },
      verificationPlan: { expectedCandidateCommit: '2'.repeat(40), checkPatchDigest: true, checkPullRequestHead: true },
    };
    const prepared = await api.proposals.create({ organizationId: workspace.id, proposal });
    const approval = await api.proposals.approve(identity, { organizationId: workspace.id, proposalId: prepared.proposalId, actionHash: prepared.actionHash, stepUpProof: randomUUID() });
    return { organizationId: workspace.id, applicationId: application.applicationId, proposalId: prepared.proposalId, approvalId: approval.approvalId, recoveryEpoch: prepared.recoveryEpoch };
  } finally { await database.close(); }
}

const temporaryRoot = await mkdir(temporary, { recursive: false, mode: 0o700 }).then(() => temporary);
let composeCreated = false;
try {
  const ports = await freePorts(5);
  const [webPort, coordinatorPort, scannerPort, postgresPort, redisPort] = ports;
  await mkdir(stateDirectory, { mode: 0o700 });
  checked('bash', ['scripts/infra-local-setup.sh'], { env: { ...process.env, GOTCHU_ENV_FILE: environmentFile, GOTCHU_AUTH_MODE: 'self_host', GOTCHU_CUSTOMER_DISCOVERY: 'true',
    GOTCHU_WEB_PORT: webPort, GOTCHU_COORDINATOR_PORT: coordinatorPort, GOTCHU_SCANNER_PORT: scannerPort, GOTCHU_POSTGRES_PORT: postgresPort, GOTCHU_REDIS_PORT: redisPort } });
  await writeFile(join(stateDirectory, '.gotchu-state'), 'gotchu-self-host-state-v1\n', { mode: 0o600 });
  await writeFile(join(stateDirectory, 'scanner.secret'), randomBytes(32), { mode: 0o600 });
  checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', join(stateDirectory, 'scanner.key'), '-out', join(stateDirectory, 'scanner.crt'), '-subj', '/CN=localhost']);
  await chmod(join(stateDirectory, 'scanner.key'), 0o600);
  environment = parseEnv(await readFile(environmentFile, 'utf8'));
  process.stdout.write('Backup live test: isolated install configured.\n');
  await bootstrapDatabase();
  composeCreated = true;
  process.stdout.write('Backup live test: Postgres initialized and roles provisioned.\n');
  const approval = await seedApprovedAction();
  process.stdout.write('Backup live test: seeded workspace and approved action.\n');

  const backupOutput = await launchGotchu(['backup'], [passphrase, passphrase]);
  process.stdout.write('Backup live test: encrypted backup created.\n');
  assert.match(backupOutput, /Copia cifrada creada/);
  assert.equal(backupOutput.includes(passphrase), false, 'the passphrase must not appear in terminal output');
  const backupDirectory = `${stateDirectory}.backups`;
  const savedBackups = await readdir(backupDirectory);
  assert.equal(savedBackups.length, 1);
  backupFile = join(backupDirectory, savedBackups[0] ?? '');
  assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(backupFile)).includes(Buffer.from(approval.organizationId)), false, 'database identifiers must be encrypted');

  const resetOutput = await launchGotchu(['reset'], ['RESET']);
  assert.match(resetOutput, /copias cifradas del directorio/);
  assert.equal(await readFile(backupFile).then(() => true, () => false), true, 'the sibling backup directory must survive reset');
  process.stdout.write('Backup live test: ./gotchu reset removed the isolated state and database volume.\n');

  const freshPorts = await freePorts(5);
  const [freshWebPort, freshCoordinatorPort, freshScannerPort, freshPostgresPort, freshRedisPort] = freshPorts;
  await mkdir(stateDirectory, { mode: 0o700 });
  checked('bash', ['scripts/infra-local-setup.sh'], { env: { ...process.env, GOTCHU_ENV_FILE: environmentFile, GOTCHU_AUTH_MODE: 'self_host', GOTCHU_CUSTOMER_DISCOVERY: 'true',
    GOTCHU_WEB_PORT: freshWebPort, GOTCHU_COORDINATOR_PORT: freshCoordinatorPort, GOTCHU_SCANNER_PORT: freshScannerPort, GOTCHU_POSTGRES_PORT: freshPostgresPort, GOTCHU_REDIS_PORT: freshRedisPort } });
  await writeFile(join(stateDirectory, '.gotchu-state'), 'gotchu-self-host-state-v1\n', { mode: 0o600 });
  await writeFile(join(stateDirectory, 'scanner.secret'), randomBytes(32), { mode: 0o600 });
  checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', join(stateDirectory, 'scanner.key'), '-out', join(stateDirectory, 'scanner.crt'), '-subj', '/CN=localhost']);
  await chmod(join(stateDirectory, 'scanner.key'), 0o600);
  environment = parseEnv(await readFile(environmentFile, 'utf8'));
  assert.notEqual(environment.get('POSTGRES_PASSWORD'), undefined);
  process.stdout.write('Backup live test: fresh local credentials created after reset.\n');
  await bootstrapDatabase();
  compose(['stop', 'postgres']);
  process.stdout.write('Backup live test: fresh target database initialized and stopped.\n');
  const restoreOutput = await launchGotchu(['restore', backupFile], [passphrase, 'RESTORE']);
  process.stdout.write('Backup live test: CLI restore completed.\n');
  assert.match(restoreOutput, /epoch de recuperación aumentó/);
  assert.equal(restoreOutput.includes(passphrase), false, 'the passphrase must not appear in terminal output');
  composeCreated = true;
  compose(['up', '-d', 'postgres']);
  await waitForPostgres();

  const { createDatabase, setRecoveryState } = await import(new URL('../packages/database/dist/index.js', import.meta.url));
  const { createBackend } = await import(new URL('../packages/backend/dist/index.js', import.meta.url));
  const restoredDatabase = new Client({ connectionString: databaseUrl(environment.get('POSTGRES_USER'), environment.get('POSTGRES_PASSWORD')) });
  await restoredDatabase.connect();
  const restoredRows = await restoredDatabase.query(`SELECT
      EXISTS(SELECT 1 FROM gotchu.organizations WHERE id=$1) AS workspace_present,
      EXISTS(SELECT 1 FROM gotchu.applications WHERE organization_id=$1 AND id=$2) AS application_present,
      (SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton) AS current_epoch,
      (SELECT recovery_epoch FROM gotchu.approvals WHERE organization_id=$1 AND id=$3) AS approval_epoch,
      (SELECT writes_frozen FROM gotchu.platform_state WHERE singleton) AS writes_frozen`,
  [approval.organizationId, approval.applicationId, approval.approvalId]);
  assert.deepEqual(restoredRows.rows[0], { workspace_present: true, application_present: true, current_epoch: String(BigInt(approval.recoveryEpoch) + 1n), approval_epoch: approval.recoveryEpoch, writes_frozen: true });
  await restoredDatabase.end();

  const executorDatabase = createDatabase({ connectionString: roleUrl('gotchu_executor'), role: 'gotchu_executor' });
  const executor = createBackend({ database: executorDatabase });
  try {
    await assert.rejects(executor.executions.claim({ organizationId: approval.organizationId, approvalId: approval.approvalId }), { code: 'writes_frozen' });
    await setRecoveryState({ connectionString: databaseUrl(environment.get('POSTGRES_USER'), environment.get('POSTGRES_PASSWORD')), mode: 'reconciled', reconciliationReference: 'Test-only check that an old approval stays stale after thaw' });
    await assert.rejects(executor.executions.claim({ organizationId: approval.organizationId, approvalId: approval.approvalId }), { code: 'stale_epoch' });
    await setRecoveryState({ connectionString: databaseUrl(environment.get('POSTGRES_USER'), environment.get('POSTGRES_PASSWORD')), mode: 'freeze' });
  } finally { await executorDatabase.close(); }
  process.stdout.write('Live self-host backup round trip passed on isolated PostgreSQL: workspace and approval restored, recovery epoch advanced, provider writes frozen, and the old approval rejected after test-only thaw.\n');
} finally {
  if (composeCreated || environment.size > 0) spawnSync('docker', ['compose', '-p', project, '--env-file', environmentFile, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], { cwd: root, stdio: 'ignore', env: stateEnvironment });
  await rm(temporaryRoot, { recursive: true, force: true });
}
