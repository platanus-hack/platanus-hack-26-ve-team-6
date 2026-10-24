#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDirectory = join(root, '.local/dev/trivy-db');
const dbDirectory = join(cacheDirectory, 'db');
const lockPath = join(cacheDirectory, 'gotchu-trivy-db.json');
const lockSchema = { version: 1, trivyVersion: '0.67.2' };
const trivyImage = 'aquasec/trivy@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08';
const repository = 'ghcr.io/aquasecurity/trivy-db';
const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' };

function run(args, label, capture = false) {
  const result = spawnSync('docker', ['--host', env.DOCKER_HOST, ...args], {
    cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${label} failed; the Trivy vulnerability database was not updated.`);
  return capture ? result.stdout : '';
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function currentLock() {
  try {
    const lock = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(lock);
    const databaseSha256 = await sha256File(join(dbDirectory, 'trivy.db'));
    const age = Date.now() - Date.parse(parsed.updatedAt);
    if (parsed.version === lockSchema.version && parsed.trivyVersion === lockSchema.trivyVersion
      && /^sha256:[a-f0-9]{64}$/.test(parsed.ociDigest) && parsed.databaseSha256 === databaseSha256
      && age >= -60 * 60 * 1000 && age <= 14 * 24 * 60 * 60 * 1000) return parsed;
  } catch {}
  return null;
}

function setScannerDatabasePermissions() {
  run([
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.25',
    '--mount', `type=bind,src=${dbDirectory},dst=/db`, '--entrypoint', '/bin/sh', trivyImage,
    '-ec', 'chmod 0755 /db && chmod 0644 /db/trivy.db /db/metadata.json && chown 65534:65534 /db /db/trivy.db /db/metadata.json',
  ], 'Trivy database ownership setup');
}

await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
const cacheInfo = await lstat(cacheDirectory);
if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new Error('The local Trivy database path must be a real directory.');
const cached = await currentLock();
let inspection;
try {
  inspection = JSON.parse(run(['manifest', 'inspect', '--verbose', `${repository}:2`], 'Public Trivy database manifest lookup', true));
} catch (error) {
  if (cached) {
    setScannerDatabasePermissions();
    console.log(`Using verified cached Trivy vulnerability database ${cached.ociDigest}; public manifest lookup is unavailable.`);
    process.exit(0);
  }
  throw error;
}
const manifestDigest = inspection.Descriptor?.digest;
if (typeof manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)
  || inspection.OCIManifest?.schemaVersion !== 2) {
  throw new Error('The public Trivy database manifest did not include a valid immutable OCI digest.');
}
if (cached?.ociDigest === manifestDigest) {
  setScannerDatabasePermissions();
  console.log(`Trivy vulnerability database is current (${cached.ociDigest}).`);
  process.exit(0);
}

// This is the only network-enabled scanner operation. It downloads one immutable database artifact.
await mkdir(dbDirectory, { recursive: true, mode: 0o755 });
const containerName = `gotchu-trivy-db-update-${randomUUID()}`;
let containerId;
try {
  containerId = run([
    'create', '--name', containerName, '--network', 'bridge', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
    '--mount', `type=bind,src=${cacheDirectory},dst=/root/.cache/trivy`, '--entrypoint', '/bin/sh', trivyImage,
    '-ec', `trivy image --download-db-only --skip-java-db-update --db-repository ${repository}@${manifestDigest} --cache-dir /root/.cache/trivy && chmod 0755 /root/.cache/trivy/db && chmod 0644 /root/.cache/trivy/db/trivy.db /root/.cache/trivy/db/metadata.json && chown 65534:65534 /root/.cache/trivy/db /root/.cache/trivy/db/trivy.db /root/.cache/trivy/db/metadata.json`,
  ], 'Pinned Trivy database updater container creation', true).trim();
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('Docker returned an invalid Trivy updater container ID.');
  run(['start', containerId], 'Pinned Trivy database updater start');
  const waitCode = run(['wait', containerId], 'Pinned Trivy database updater completion', true).trim();
  if (waitCode !== '0') throw new Error('The pinned Trivy database updater did not complete successfully.');
  const exitCode = run(['inspect', '--format', '{{.State.ExitCode}}', containerId], 'Pinned Trivy database updater result', true).trim();
  if (exitCode !== '0') throw new Error('The pinned Trivy database updater did not complete successfully.');
} finally {
  if (containerId) spawnSync('docker', ['--host', env.DOCKER_HOST, 'rm', '--force', containerId], { cwd: root, env, stdio: 'ignore' });
}

const dbInfo = await lstat(join(dbDirectory, 'trivy.db'));
if (!dbInfo.isFile() || dbInfo.isSymbolicLink() || dbInfo.size < 1) throw new Error('Trivy did not write a regular vulnerability database file.');
const metadata = JSON.parse(await readFile(join(dbDirectory, 'metadata.json'), 'utf8'));
if (typeof metadata.UpdatedAt !== 'string' || Number.isNaN(Date.parse(metadata.UpdatedAt))
  || Date.parse(metadata.UpdatedAt) > Date.now() + 60 * 60 * 1000
  || Date.now() - Date.parse(metadata.UpdatedAt) > 14 * 24 * 60 * 60 * 1000) {
  throw new Error('Trivy vulnerability database metadata is missing or stale.');
}
const databaseInfo = await lstat(join(dbDirectory, 'trivy.db'));
if ((dbInfo.mode & 0o044) !== 0o044 || (databaseInfo.mode & 0o044) !== 0o044
  || (dbInfo.mode & 0o200) !== 0o200 || (databaseInfo.mode & 0o200) !== 0o200) {
  throw new Error('Trivy database files must be readable and owned by the isolated scanner uid.');
}
const databaseSha256 = await sha256File(join(dbDirectory, 'trivy.db'));
const lock = { ...lockSchema, ociDigest: manifestDigest, updatedAt: new Date(metadata.UpdatedAt).toISOString(), databaseSha256 };
const temporary = `${lockPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, lockPath);
await rm(`${lockPath}.tmp`, { force: true });
await chmod(lockPath, 0o644);
console.log(`Downloaded Trivy vulnerability database ${manifestDigest} (${databaseSha256}).`);
