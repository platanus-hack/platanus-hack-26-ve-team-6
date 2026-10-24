import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { describe, expect, it } from 'vitest';
import type { CustomerRunInput } from '@gotchu/contracts';
import { sourceDigest } from '@gotchu/customer-assessment';
import { createScannerClient } from '../src/client.js';

const smokeEnabled = process.env.GOTCHU_SCANNER_PRODUCTION_SMOKE === '1';
const productionSmoke = smokeEnabled ? describe : describe.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('production_smoke_port_unavailable');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function readReadiness(origin: string, ca: Buffer): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL('/readyz', origin), {
      method: 'GET', agent: false, ca, rejectUnauthorized: true, signal: AbortSignal.timeout(45_000), maxHeaderSize: 8192,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          response.destroy();
          reject(new Error('production_smoke_readiness_limit'));
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: response.statusCode ?? 0, body });
        }
        catch { reject(new Error('production_smoke_readiness_invalid')); }
      });
      response.on('error', () => reject(new Error('production_smoke_readiness_unavailable')));
    });
    request.on('error', () => reject(new Error('production_smoke_transport_unavailable')));
    request.end();
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}

productionSmoke('production scanner process with real Docker profiles', () => {
  it('starts with TLS, reports real readiness, and accepts a signed assessment of application source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gotchu-production-scanner-'));
    let child: ChildProcess | undefined;
    try {
      const certPath = join(directory, 'cert.pem');
      const keyPath = join(directory, 'key.pem');
      const secretPath = join(directory, 'secret.bin');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment', '-addext', 'subjectAltName=IP:127.0.0.1',
      ], { stdio: 'ignore', timeout: 10_000 });
      const secret = randomBytes(32);
      await writeFile(secretPath, secret, { mode: 0o600 });
      const ca = await readFile(certPath);
      const port = await availablePort();
      const sourcePath = join(repositoryRoot, 'apps/web/src/server/customer-api.ts');
      const sourceText = await readFile(sourcePath, 'utf8');
      const snapshot = { revision: 'gotchu-application-source', files: [{ path: 'customer-api.ts', content: sourceText }] };
      const request: CustomerRunInput = {
        version: 2, organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(),
        applicationName: 'Gotchu application source smoke', mode: 'internal',
        source: { ...snapshot, id: randomUUID(), digest: sourceDigest(snapshot) }, target: null,
      };
      child = spawn(process.execPath, [join(repositoryRoot, 'apps/scanner/dist/main.js')], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          NODE_ENV: 'production',
          GOTCHU_SCANNER_HOST: '127.0.0.1',
          GOTCHU_SCANNER_PORT: String(port),
          GOTCHU_SCANNER_SECRET_FILE: secretPath,
          GOTCHU_SCANNER_TLS_CERT_FILE: certPath,
          GOTCHU_SCANNER_TLS_KEY_FILE: keyPath,
          GOTCHU_SCANNER_OSV: '1',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      const origin = `https://127.0.0.1:${port}`;
      const readiness = await readReadiness(origin, ca);
      expect(readiness.status).toBe(200);
      expect(readiness.body).toMatchObject({ ready: true });
      const report = await createScannerClient({ origin, secret, ca, timeoutMs: 65_000 }).run(request);
      expect(report.subject.sourceDigest).toBe(request.source?.digest);
      expect(report.internal?.coverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability: 'semgrep', state: 'inspected' }),
        expect.objectContaining({ capability: 'gitleaks', state: 'inspected' }),
        expect.objectContaining({ capability: 'trivy', state: 'inspected' }),
      ]));
    } finally {
      if (child) {
        child.kill('SIGTERM');
        const exited = waitForExit(child);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]);
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
