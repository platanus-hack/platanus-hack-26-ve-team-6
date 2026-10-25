// Maintainer-only image preparation. No downloaded package code is executed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const rootfs = process.argv[2];
if (!rootfs) throw new Error('Expected the private rootfs build directory');
const lock = JSON.parse(await readFile(new URL('../guest/node-toolchain.lock.json', import.meta.url), 'utf8'));
if (lock.version !== 1 || lock.architecture !== 'linux-x64' || !Array.isArray(lock.packages) || lock.packages.length !== 3) {
  throw new Error('Unsupported runner toolchain lock');
}
for (const entry of lock.packages) {
  if (!['tsx', 'esbuild', '@esbuild/linux-x64'].includes(entry.directory)
    || typeof entry.url !== 'string' || !entry.url.startsWith('https://registry.npmjs.org/')
    || typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
    throw new Error('Invalid runner toolchain package');
  }
  const response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Runner toolchain fetch failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Runner toolchain tarball exceeds limit');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error('Runner toolchain integrity mismatch');
  const destination = join(rootfs, 'usr/local/lib/gotchu-node-selected/node_modules', entry.directory);
  const tarball = join(rootfs, 'gotchu-toolchain.tgz');
  await mkdir(destination, { recursive: true });
  await writeFile(tarball, bytes, { mode: 0o600 });
  await run('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1', '--no-same-owner', '--no-same-permissions']);
  await rm(tarball);
}
