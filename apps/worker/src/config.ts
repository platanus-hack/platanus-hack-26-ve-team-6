import { readFile } from 'node:fs/promises';
import { importSPKI, type CryptoKey } from 'jose';
import { z } from 'zod';

export interface WorkerConfig {
  readonly host: string;
  readonly port: number;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly capabilityPublicKey: CryptoKey;
  readonly gatewayBaseUrl?: URL;
  /** Serves HTTPS when set; plain HTTP is only accepted by callers for loopback development. */
  readonly tls?: { readonly certificate: string; readonly privateKey: string };
}

export class WorkerConfigError extends Error {
  constructor(readonly code: 'capability_public_key_missing' | 'capability_public_key_invalid' | 'gateway_url_invalid' | 'tls_invalid' | 'port_invalid' | 'host_invalid' | 'node_env_invalid') {
    super(code);
    this.name = 'WorkerConfigError';
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function parseGatewayUrl(value: string | undefined, nodeEnv: WorkerConfig['nodeEnv']): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkerConfigError('gateway_url_invalid');
  }
  const secure = url.protocol === 'https:';
  const allowedLocalHttp = (nodeEnv === 'development' || nodeEnv === 'test') && url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (
    (!secure && !allowedLocalHttp)
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new WorkerConfigError('gateway_url_invalid');
  }
  return new URL(url.origin);
}

export async function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): Promise<WorkerConfig> {
  const nodeEnvValue = env.NODE_ENV ?? 'production';
  const nodeEnvResult = z.enum(['development', 'test', 'production']).safeParse(nodeEnvValue);
  if (!nodeEnvResult.success) throw new WorkerConfigError('node_env_invalid');
  const nodeEnv = nodeEnvResult.data;

  const portText = env.PORT ?? '3001';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new WorkerConfigError('port_invalid');
  const host = env.GOTCHU_WORKER_HOST ?? '0.0.0.0';
  if (!/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(host)) throw new WorkerConfigError('host_invalid');

  const pem = env.GOTCHU_RUN_CAPABILITY_PUBLIC_KEY?.replace(/\\n/g, '\n').trim();
  if (!pem) throw new WorkerConfigError('capability_public_key_missing');
  let capabilityPublicKey: CryptoKey;
  try {
    capabilityPublicKey = await importSPKI(pem, 'EdDSA');
  } catch {
    throw new WorkerConfigError('capability_public_key_invalid');
  }

  const gatewayBaseUrl = parseGatewayUrl(env.GOTCHU_GATEWAY_URL, nodeEnv);
  const certificatePath = env.GOTCHU_WORKER_TLS_CERT_FILE;
  const privateKeyPath = env.GOTCHU_WORKER_TLS_KEY_FILE;
  if (Boolean(certificatePath) !== Boolean(privateKeyPath)) throw new WorkerConfigError('tls_invalid');
  let tls: WorkerConfig['tls'];
  if (certificatePath && privateKeyPath) {
    try {
      const [certificate, privateKey] = await Promise.all([readFile(certificatePath, 'utf8'), readFile(privateKeyPath, 'utf8')]);
      tls = { certificate, privateKey };
    } catch { throw new WorkerConfigError('tls_invalid'); }
  }
  return {
    host,
    port,
    nodeEnv,
    capabilityPublicKey,
    ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
    ...(tls ? { tls } : {}),
  };
}
