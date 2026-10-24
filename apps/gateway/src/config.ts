import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importSPKI, type CryptoKey } from 'jose';
import { z } from 'zod';

export type GatewayTransport =
  | { readonly mode: 'https'; readonly certificate: string; readonly privateKey: string }
  | { readonly mode: 'loopback-http'; readonly nodeEnv: 'development' | 'test' };
export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly capabilityPublicKey: CryptoKey;
  readonly transport: GatewayTransport;
  readonly modelSecretDirectory?: string;
  readonly modelProbeSecret?: Uint8Array;
  readonly allowSelfHostedModelEndpoints: boolean;
}

export function assertTransport(host: string, transport: GatewayTransport): void {
  if (transport.mode === 'loopback-http') {
    if (!['127.0.0.1', '::1'].includes(host) || !['development', 'test'].includes(transport.nodeEnv)) {
      throw new Error('Plain HTTP requires a literal loopback bind in development or test');
    }
  } else if (transport.mode !== 'https' || !transport.certificate || !transport.privateKey) {
    throw new Error('Gateway requires TLS');
  }
}

export async function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  const nodeEnv = z.enum(['development', 'test', 'production']).parse(env.NODE_ENV ?? 'production');
  const host = z.enum(['127.0.0.1', '::1', '0.0.0.0', '::']).parse(env.GOTCHU_GATEWAY_HOST ?? '127.0.0.1');
  const port = z.coerce.number().int().min(1).max(65_535).parse(env.PORT ?? '3002');
  const databaseUrl = z.string().url().parse(env.GOTCHU_GATEWAY_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('Invalid database configuration');
  const publicPem = env.GOTCHU_RUN_CAPABILITY_PUBLIC_KEY?.replace(/\\n/g, '\n').trim();
  if (!publicPem) throw new Error('Capability public key is required');
  const capabilityPublicKey = await importSPKI(publicPem, 'EdDSA');
  if (capabilityPublicKey.type !== 'public' || capabilityPublicKey.algorithm.name !== 'Ed25519') throw new Error('Ed25519 public key is required');
  let transport: GatewayTransport;
  const certificatePath = env.GOTCHU_GATEWAY_TLS_CERT_FILE;
  const privateKeyPath = env.GOTCHU_GATEWAY_TLS_KEY_FILE;
  if (certificatePath || privateKeyPath) {
    if (!certificatePath || !privateKeyPath) throw new Error('TLS certificate and key are both required');
    const [certificate, privateKey] = await Promise.all([readFile(certificatePath, 'utf8'), readFile(privateKeyPath, 'utf8')]);
    transport = { mode: 'https', certificate, privateKey };
  } else {
    if (nodeEnv === 'production' || env.GOTCHU_GATEWAY_ALLOW_LOOPBACK_HTTP !== 'true') throw new Error('Gateway TLS is required');
    transport = { mode: 'loopback-http', nodeEnv };
  }
  assertTransport(host, transport);
  const modelSecretDirectory = env.GOTCHU_MODEL_SECRET_DIRECTORY ?? (nodeEnv === 'production' ? undefined : resolve('.local/dev/model-secrets'));
  const encodedProbeSecret = env.GOTCHU_GATEWAY_MODEL_PROBE_SECRET;
  const modelProbeSecret = encodedProbeSecret ? Buffer.from(z.string().regex(/^[A-Za-z0-9_-]+$/).parse(encodedProbeSecret), 'base64url') : undefined;
  if (modelProbeSecret && (modelProbeSecret.byteLength < 32 || modelProbeSecret.toString('base64url') !== encodedProbeSecret)) {
    throw new Error('Model probe secret must be at least 32 bytes encoded as unpadded base64url');
  }
  return { host, port, databaseUrl, capabilityPublicKey, transport,
    allowSelfHostedModelEndpoints: env.GOTCHU_ALLOW_SELF_HOSTED_LLM_ENDPOINT === 'true',
    ...(modelSecretDirectory ? { modelSecretDirectory } : {}), ...(modelProbeSecret ? { modelProbeSecret } : {}) };
}
