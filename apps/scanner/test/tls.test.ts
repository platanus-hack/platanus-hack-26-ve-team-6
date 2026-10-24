import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CustomerRunInput } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, sourceDigest } from '@gotchu/customer-assessment';
import { createScannerClient, createScannerServer, MAX_SCANNER_CA_BYTES, readScannerCaFile, validateScannerCa } from '../src/index.js';
import { loadScannerRuntimeConfig, parseScannerRuntimeEnvironment } from '../src/runtime-config.js';

let directory: string;
let cert: Buffer;
let key: Buffer;
let otherKey: Buffer;
const cleanups: Array<() => Promise<void>> = [];
const secret = randomBytes(32);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-scanner-tls-'));
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  const otherKeyPath = join(directory, 'other-key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 10_000 });
  execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', otherKeyPath], { stdio: 'ignore', timeout: 10_000 });
  cert = await readFile(certPath);
  key = await readFile(keyPath);
  otherKey = await readFile(otherKeyPath);
});

afterAll(async () => rm(directory, { recursive: true, force: true }));
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function input(): CustomerRunInput {
  const snapshot = { revision: 'synthetic-source', files: [{ path: 'main.ts', content: 'export const hello = 1;' }] };
  return {
    version: 2,
    organizationId: randomUUID(),
    applicationId: randomUUID(),
    jobId: randomUUID(),
    applicationName: 'Synthetic TLS roundtrip',
    mode: 'internal',
    source: { ...snapshot, id: randomUUID(), digest: sourceDigest(snapshot) },
    target: null,
  };
}

function syntheticRunner() {
  const assessment = createCustomerAssessmentRunner({ scanners: {
    async run() { throw new Error('synthetic_scanner_unavailable'); },
    async readiness() { return { ready: false, tools: [] }; },
  } });
  return {
    run: assessment.run,
    async readiness() { return { ready: true, tools: [{ name: 'synthetic-runner', available: true }] }; },
  };
}

async function listen(server: ReturnType<typeof createScannerServer>, host = '127.0.0.1') {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('scanner_test_listener_unavailable');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { port: address.port, origin: `https://127.0.0.1:${address.port}` };
}

function plainGet(origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/readyz', origin), response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('scanner runtime TLS configuration', () => {
  it('defaults to loopback and requires TLS for production and non-loopback hosts', () => {
    const dev = parseScannerRuntimeEnvironment({ NODE_ENV: 'development', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret' });
    expect(dev).toMatchObject({ host: '127.0.0.1', port: 4400, osvEnabled: false });
    expect(() => parseScannerRuntimeEnvironment({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret' })).toThrow('scanner_tls_required');
    expect(() => parseScannerRuntimeEnvironment({ NODE_ENV: 'test', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret', GOTCHU_SCANNER_HOST: 'scanner.internal' })).toThrow('invalid_scanner_host');
    expect(() => parseScannerRuntimeEnvironment({ NODE_ENV: 'development', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret', GOTCHU_SCANNER_HOST: '10.0.0.2' })).toThrow('scanner_tls_required');
    expect(() => parseScannerRuntimeEnvironment({ NODE_ENV: 'development', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret', GOTCHU_SCANNER_PORT: '65536' })).toThrow('invalid_scanner_port');
    expect(() => parseScannerRuntimeEnvironment({ NODE_ENV: 'development', GOTCHU_SCANNER_SECRET_FILE: '/tmp/secret', GOTCHU_SCANNER_TLS_CERT_FILE: '/tmp/cert' })).toThrow('scanner_tls_files_must_be_configured_together');
  });

  it('loads bounded secrets and TLS identity, rejecting missing, invalid, and mismatched files', async () => {
    const secretPath = join(directory, 'secret.bin');
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    const otherKeyPath = join(directory, 'other-key.pem');
    await writeFile(secretPath, secret);
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: certPath, GOTCHU_SCANNER_TLS_KEY_FILE: keyPath })).resolves.toMatchObject({ host: '127.0.0.1', tls: { cert, key } });
    const canonicalCert = Buffer.from(new X509Certificate(cert).toString().trim(), 'ascii');
    await expect(readScannerCaFile(certPath)).resolves.toEqual(canonicalCert);
    await expect(readScannerCaFile(secretPath)).rejects.toThrow('invalid_scanner_ca_file');
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: certPath })).rejects.toThrow('scanner_tls_files_must_be_configured_together');
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: certPath, GOTCHU_SCANNER_TLS_KEY_FILE: otherKeyPath })).rejects.toThrow('invalid_scanner_tls_identity');

    const badCertPath = join(directory, 'bad-cert.pem');
    const largeKeyPath = join(directory, 'large-key.pem');
    await writeFile(badCertPath, 'not a certificate');
    await writeFile(largeKeyPath, Buffer.alloc(64 * 1024 + 1));
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: badCertPath, GOTCHU_SCANNER_TLS_KEY_FILE: keyPath })).rejects.toThrow('invalid_scanner_tls_identity');
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: certPath, GOTCHU_SCANNER_TLS_KEY_FILE: largeKeyPath })).rejects.toThrow('invalid_scanner_tls_key_file');
    await expect(loadScannerRuntimeConfig({ NODE_ENV: 'production', GOTCHU_SCANNER_SECRET_FILE: secretPath, GOTCHU_SCANNER_TLS_CERT_FILE: join(directory, 'missing.pem'), GOTCHU_SCANNER_TLS_KEY_FILE: keyPath })).rejects.toThrow('invalid_scanner_tls_cert_file');
  });

  it('validates every certificate in a bounded operator CA PEM bundle', async () => {
    const validBundle = Buffer.concat([cert, Buffer.from('\n'), cert]);
    const canonicalCert = Buffer.from(new X509Certificate(cert).toString().trim(), 'ascii');
    const canonicalBundle = Buffer.concat([canonicalCert, Buffer.from('\n'), canonicalCert]);
    expect(validateScannerCa(validBundle)).toEqual(canonicalBundle);
    await expect(readScannerCaFile(join(directory, 'bundle.pem'))).rejects.toThrow('invalid_scanner_ca_file');
    const bundlePath = join(directory, 'bundle.pem');
    await writeFile(bundlePath, validBundle);
    await expect(readScannerCaFile(bundlePath)).resolves.toEqual(canonicalBundle);

    const invalidPem = [
      Buffer.from('not a certificate'),
      Buffer.from('-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'),
      Buffer.concat([cert, Buffer.from('\ninvalid trailing content')]),
      Buffer.concat([Buffer.from([0xad]), cert.subarray(1)]),
      Buffer.concat([cert, Buffer.from('\n-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----')]),
    ];
    for (const value of invalidPem) {
      expect(() => validateScannerCa(value)).toThrow('invalid_scanner_ca');
      const caPath = join(directory, `invalid-ca-${randomUUID()}.pem`);
      await writeFile(caPath, value);
      await expect(readScannerCaFile(caPath)).rejects.toThrow('invalid_scanner_ca_file');
      expect(() => createScannerClient({ origin: 'https://127.0.0.1:4400', secret, ca: value })).toThrow('invalid_scanner_ca');
    }
    expect(() => validateScannerCa(Buffer.alloc(MAX_SCANNER_CA_BYTES + 1))).toThrow('invalid_scanner_ca');
  });

  it('rejects malformed and mismatched TLS identities before a listener can be created', () => {
    expect(() => createScannerServer({ secret, runner: syntheticRunner(), tls: { cert: Buffer.from('invalid'), key } })).toThrow('invalid_scanner_tls_identity');
    expect(() => createScannerServer({ secret, runner: syntheticRunner(), tls: { cert, key: otherKey } })).toThrow('invalid_scanner_tls_identity');
  });
});

describe('scanner TLS transport', () => {
  it('serves a signed real HTTPS roundtrip with an injected synthetic runner', async () => {
    const runner = syntheticRunner();
    const run = vi.spyOn(runner, 'run');
    const server = createScannerServer({ secret, runner, tls: { cert, key } });
    const { origin } = await listen(server);
    const request = input();
    const report = await createScannerClient({ origin, secret, ca: cert }).run(request);
    expect(run).toHaveBeenCalledWith(request);
    expect(report.subject.sourceDigest).toBe(request.source?.digest);
  });

  it('uses canonical CA PEM for leading whitespace and adjacent certificate TLS bundles', async () => {
    const server = createScannerServer({ secret, runner: syntheticRunner(), tls: { cert, key } });
    const { origin } = await listen(server);
    const certificate = new X509Certificate(cert).toString().trim();
    const caVariants = [
      Buffer.concat([Buffer.from(' '), cert]),
      Buffer.concat([Buffer.from('\t'), cert]),
      Buffer.from(`${certificate}${certificate}`, 'ascii'),
    ];

    for (const ca of caVariants) {
      const request = input();
      const report = await createScannerClient({ origin, secret, ca }).run(request);
      expect(report.subject.sourceDigest).toBe(request.source?.digest);
    }
  });

  it('rejects an untrusted CA and a trusted certificate with the wrong hostname', async () => {
    const server = createScannerServer({ secret, runner: syntheticRunner(), tls: { cert, key } });
    const { origin, port } = await listen(server, '0.0.0.0');
    await expect(createScannerClient({ origin, secret }).run(input())).rejects.toThrow('scanner_transport_unavailable');
    await expect(createScannerClient({ origin: `https://127.0.0.2:${port}`, secret, ca: cert }).run(input())).rejects.toThrow('scanner_transport_unavailable');
  });

  it('rejects plaintext requests at the TLS listener', async () => {
    const server = createScannerServer({ secret, runner: syntheticRunner(), tls: { cert, key } });
    const { port } = await listen(server);
    await expect(plainGet(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });

  it('rejects operator CA trust on plaintext origins', () => {
    expect(() => createScannerClient({ origin: 'http://127.0.0.1:4400', secret, ca: cert, allowDevelopmentHttp: true })).toThrow('scanner_ca_requires_https');
  });
});
