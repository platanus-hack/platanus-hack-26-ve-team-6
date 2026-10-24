import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertTransport, loadGatewayConfig } from '../src/config.js';

const keys = generateKeyPairSync('ed25519');
const env = {
  GOTCHU_GATEWAY_DATABASE_URL: 'postgres://runtime:unused@127.0.0.1/gotchu_test_config',
  GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

describe('gateway deployment boundary', () => {
  it('requires TLS by default and in production even with the development flag', async () => {
    await expect(loadGatewayConfig(env)).rejects.toThrow('TLS');
    await expect(loadGatewayConfig({ ...env, NODE_ENV: 'production', GOTCHU_GATEWAY_ALLOW_LOOPBACK_HTTP: 'true' })).rejects.toThrow('TLS');
  });
  it('allows HTTP only with explicit development/test intent and literal loopback bind', async () => {
    const local = { ...env, NODE_ENV: 'test', GOTCHU_GATEWAY_ALLOW_LOOPBACK_HTTP: 'true' };
    expect((await loadGatewayConfig(local)).transport).toEqual({ mode: 'loopback-http', nodeEnv: 'test' });
    await expect(loadGatewayConfig({ ...local, GOTCHU_GATEWAY_HOST: '0.0.0.0' })).rejects.toThrow('loopback');
    expect(() => assertTransport('example.org', { mode: 'loopback-http', nodeEnv: 'development' })).toThrow('loopback');
  });
  it('rejects private signing material and incomplete TLS configuration', async () => {
    await expect(loadGatewayConfig({ ...env, GOTCHU_RUN_CAPABILITY_PUBLIC_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).rejects.toThrow();
    await expect(loadGatewayConfig({ ...env, GOTCHU_GATEWAY_TLS_CERT_FILE: '/not/read' })).rejects.toThrow('both required');
  });
});
