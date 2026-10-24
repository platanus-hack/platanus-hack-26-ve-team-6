#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const allowed = new Map([
  ['database.dump', 'file'], ['state/', 'directory'], ['state/.env', 'file'], ['state/.gotchu-state', 'file'],
  ['state/scanner.secret', 'file'], ['state/scanner.crt', 'file'], ['state/scanner.key', 'file'],
  ['state/scanner.tls-fingerprint', 'file'], ['state/github/', 'directory'], ['state/github/reader-app.json', 'file'],
]);
const required = ['database.dump', 'state/', 'state/.env', 'state/.gotchu-state', 'state/scanner.secret', 'state/scanner.crt', 'state/scanner.key'];

function entries(archive) {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trimEnd().split('\n');
  const verbose = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trimEnd().split('\n');
  if (names.length !== verbose.length || names.length > allowed.size) throw new Error('invalid_archive_entries');
  const seen = new Set();
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const mode = verbose[index]?.match(/^([a-zA-Z-])/u)?.[1];
    const expected = allowed.get(name ?? '');
    if (!name || !expected || seen.has(name) || (expected === 'directory' ? mode !== 'd' : mode !== '-')) throw new Error('invalid_archive_path_or_type');
    seen.add(name);
  }
  if (required.some(name => !seen.has(name))) throw new Error('incomplete_archive');
  const scanner = ['state/scanner.crt', 'state/scanner.key'].filter(name => seen.has(name));
  if (scanner.length !== 2) throw new Error('incomplete_scanner_identity');
}

const [operation, archive, destination] = process.argv.slice(2);
if (!['validate', 'extract'].includes(operation) || !archive || (operation === 'extract' && !destination)) {
  process.stderr.write(`Usage: ${basename(process.argv[1] ?? 'gotchu-backup-archive.mjs')} validate <archive> [destination]\n`);
  process.exit(2);
}

try {
  entries(resolve(archive));
  if (operation === 'extract') {
    await mkdir(resolve(destination), { recursive: false, mode: 0o700 });
    execFileSync('tar', ['-xzf', resolve(archive), '--no-same-owner', '--no-same-permissions', '-C', resolve(destination)], { stdio: 'ignore' });
  }
} catch {
  process.stderr.write('El contenido del respaldo no tiene un formato permitido.\n');
  process.exit(1);
}
