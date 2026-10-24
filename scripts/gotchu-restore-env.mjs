#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const preserveFromInstall = new Set([
  'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_HOST_PORT',
  'REDIS_PASSWORD', 'REDIS_HOST_PORT', 'WEB_HOST_PORT', 'COORDINATOR_HOST_PORT', 'SCANNER_HOST_PORT', 'PUBLIC_APP_URL',
  'GOTCHU_CONTAINER_UID', 'GOTCHU_CONTAINER_GID',
  'GOTCHU_API_DB_USERNAME', 'GOTCHU_API_DB_PASSWORD', 'GOTCHU_INGEST_DB_USERNAME', 'GOTCHU_INGEST_DB_PASSWORD',
  'GOTCHU_COORDINATOR_DB_USERNAME', 'GOTCHU_COORDINATOR_DB_PASSWORD', 'GOTCHU_GATEWAY_DB_USERNAME', 'GOTCHU_GATEWAY_DB_PASSWORD',
  'GOTCHU_EXECUTOR_DB_USERNAME', 'GOTCHU_EXECUTOR_DB_PASSWORD',
]);
const databaseIdentity = [
  'POSTGRES_DB', 'POSTGRES_USER', 'GOTCHU_API_DB_USERNAME', 'GOTCHU_INGEST_DB_USERNAME',
  'GOTCHU_COORDINATOR_DB_USERNAME', 'GOTCHU_GATEWAY_DB_USERNAME', 'GOTCHU_EXECUTOR_DB_USERNAME',
];

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      if (line.trim() && !line.trimStart().startsWith('#')) throw new Error('invalid_env_line');
      continue;
    }
    const [, name, value] = match;
    if (!name || values.has(name)) throw new Error('duplicate_env_key');
    values.set(name, value ?? '');
  }
  return values;
}

const [backupPath, installPath, outputPath] = process.argv.slice(2);
if (!backupPath || !installPath || !outputPath || resolve(outputPath) === resolve(backupPath) || resolve(outputPath) === resolve(installPath)) {
  process.stderr.write(`Usage: ${basename(process.argv[1] ?? 'gotchu-restore-env.mjs')} <backup-env> <install-env> <output>\n`);
  process.exit(2);
}

try {
  const backup = parse(await readFile(backupPath, 'utf8'));
  const install = parse(await readFile(installPath, 'utf8'));
  for (const key of databaseIdentity) {
    if (!backup.get(key) || backup.get(key) !== install.get(key)) throw new Error('database_identity_mismatch');
  }
  for (const key of preserveFromInstall) {
    const value = install.get(key);
    if (value === undefined) throw new Error('missing_install_setting');
    backup.set(key, value);
  }
  await writeFile(outputPath, [...backup].map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
} catch {
  process.stderr.write('La configuración del respaldo no coincide con esta instalación.\n');
  process.exit(1);
}
