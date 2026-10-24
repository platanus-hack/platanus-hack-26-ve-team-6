import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import { checkSecret } from './auth.js';
import { validateScannerCa, MAX_SCANNER_CA_BYTES } from './client.js';
import type { ScannerTlsIdentity } from './server.js';

const MAX_SCANNER_SECRET_BYTES = 1024;
const MAX_SCANNER_CERT_BYTES = 256 * 1024;
const MAX_SCANNER_KEY_BYTES = 64 * 1024;

export type ScannerRuntimeEnvironment = 'production' | 'development' | 'test';

export interface ParsedScannerRuntimeEnvironment {
  nodeEnv: ScannerRuntimeEnvironment;
  port: number;
  host: string;
  secretFile: string;
  tlsFiles?: { cert: string; key: string };
  osvEnabled: boolean;
}

export interface ScannerRuntimeConfig extends Omit<ParsedScannerRuntimeEnvironment, 'secretFile' | 'tlsFiles'> {
  secret: Buffer;
  tls?: ScannerTlsIdentity;
}

type Environment = Readonly<Record<string, string | undefined>>;

function isLoopbackAddress(host: string): boolean {
  if (isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  return host === '::1';
}

export function parseScannerRuntimeEnvironment(env: Environment): ParsedScannerRuntimeEnvironment {
  const rawNodeEnv = env.NODE_ENV ?? 'production';
  if (rawNodeEnv !== 'production' && rawNodeEnv !== 'development' && rawNodeEnv !== 'test') throw new Error('invalid_scanner_environment');
  const nodeEnv = rawNodeEnv;

  const rawPort = env.GOTCHU_SCANNER_PORT ?? '4400';
  if (!/^\d{1,5}$/.test(rawPort)) throw new Error('invalid_scanner_port');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_scanner_port');

  const host = env.GOTCHU_SCANNER_HOST ?? '127.0.0.1';
  if (isIP(host) === 0) throw new Error('invalid_scanner_host');

  const secretFile = env.GOTCHU_SCANNER_SECRET_FILE;
  if (secretFile === undefined || secretFile.length === 0) throw new Error('scanner_secret_file_required');

  const certFile = env.GOTCHU_SCANNER_TLS_CERT_FILE;
  const keyFile = env.GOTCHU_SCANNER_TLS_KEY_FILE;
  if ((certFile === undefined) !== (keyFile === undefined)) throw new Error('scanner_tls_files_must_be_configured_together');
  if (certFile !== undefined && certFile.length === 0 || keyFile !== undefined && keyFile.length === 0) throw new Error('invalid_scanner_tls_file');
  const tlsFiles = certFile !== undefined && keyFile !== undefined ? { cert: certFile, key: keyFile } : undefined;
  if ((nodeEnv === 'production' || !isLoopbackAddress(host)) && !tlsFiles) throw new Error('scanner_tls_required');

  const rawOsv = env.GOTCHU_SCANNER_OSV;
  if (rawOsv !== undefined && rawOsv !== '0' && rawOsv !== '1') throw new Error('invalid_scanner_osv_setting');

  return { nodeEnv, port, host, secretFile, ...(tlsFiles ? { tlsFiles } : {}), osvEnabled: rawOsv === '1' };
}

async function readBoundedFile(path: string, maxBytes: number, errorCode: string): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) throw new Error(errorCode);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes) throw new Error(errorCode);

    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length < 1 || length > maxBytes) throw new Error(errorCode);
    return Buffer.from(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    await file?.close();
  }
}

export async function readScannerCaFile(path: string): Promise<Buffer> {
  const ca = await readBoundedFile(path, MAX_SCANNER_CA_BYTES, 'invalid_scanner_ca_file');
  try { return validateScannerCa(ca); }
  catch { throw new Error('invalid_scanner_ca_file'); }
}

export async function loadScannerRuntimeConfig(env: Environment = process.env): Promise<ScannerRuntimeConfig> {
  const parsed = parseScannerRuntimeEnvironment(env);
  const secret = await readBoundedFile(parsed.secretFile, MAX_SCANNER_SECRET_BYTES, 'invalid_scanner_secret_file');
  try { checkSecret(secret); }
  catch { throw new Error('invalid_scanner_secret_file'); }

  if (!parsed.tlsFiles) return { nodeEnv: parsed.nodeEnv, port: parsed.port, host: parsed.host, secret, osvEnabled: parsed.osvEnabled };
  const cert = await readBoundedFile(parsed.tlsFiles.cert, MAX_SCANNER_CERT_BYTES, 'invalid_scanner_tls_cert_file');
  const key = await readBoundedFile(parsed.tlsFiles.key, MAX_SCANNER_KEY_BYTES, 'invalid_scanner_tls_key_file');
  try { createSecureContext({ cert, key, minVersion: 'TLSv1.2' }); }
  catch { throw new Error('invalid_scanner_tls_identity'); }
  return { nodeEnv: parsed.nodeEnv, port: parsed.port, host: parsed.host, secret, osvEnabled: parsed.osvEnabled, tls: { cert, key } };
}
