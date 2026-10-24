import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError, loadWorkerConfig } from '../src/config.js';

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('worker configuration', () => {
  it('requires a verifier public key and validates the gateway origin', async () => {
    await expect(loadWorkerConfig({ NODE_ENV: 'test' })).rejects.toMatchObject({ code: 'capability_public_key_missing' });
    await expect(loadWorkerConfig({ NODE_ENV: 'production', GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: publicKeyPem, GOTCHU_GATEWAY_URL: 'http://gateway.example' }))
      .rejects.toMatchObject({ code: 'gateway_url_invalid' });

    const config = await loadWorkerConfig({
      NODE_ENV: 'test',
      PORT: '3010',
      GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: publicKeyPem,
      GOTCHU_GATEWAY_URL: 'http://127.0.0.1:8443',
    });
    expect(config.port).toBe(3010);
    expect(config.gatewayBaseUrl?.origin).toBe('http://127.0.0.1:8443');
  });

  it('rejects caller-controlled URL components and invalid ports', async () => {
    await expect(loadWorkerConfig({
      NODE_ENV: 'test',
      GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: publicKeyPem,
      GOTCHU_GATEWAY_URL: 'http://user:pass@127.0.0.1:8443',
    })).rejects.toBeInstanceOf(WorkerConfigError);
    await expect(loadWorkerConfig({
      PORT: '70000',
      GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: publicKeyPem,
    })).rejects.toMatchObject({ code: 'port_invalid' });
  });
});
