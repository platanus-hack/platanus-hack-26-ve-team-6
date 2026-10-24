import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGotchuGuard, GotchuProtectionBlockedError, verifyRuntimeProtectionPolicy } from '../src/index.js';

const integrationId = '10000000-0000-4000-8000-000000000001';
const applicationId = '20000000-0000-4000-8000-000000000002';
const secret = Buffer.alloc(32, 7);
const detectors = ['sql_injection', 'path_traversal', 'command_injection', 'ssrf'] as const;
const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;

function signedPolicy(mode: 'monitor' | 'block', enabledDetectors = [...detectors], expiresAt = new Date(Date.now() + 30_000).toISOString()) {
  const policy = { applicationId, mode, enabledDetectors, issuedAt: new Date().toISOString(), expiresAt };
  return { policy, signature: createHmac('sha256', secret).update(`gotchu-runtime-policy-v1\n${canonicalJson(policy)}`).digest('hex') };
}

function guard(mode: 'monitor' | 'block' = 'block', onFetch: (input: RequestInfo | URL) => void = () => undefined) {
  const batches: unknown[] = [];
  const policy = signedPolicy(mode);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/v1/protection/policy')) return Response.json(policy);
    batches.push(JSON.parse(String(init?.body)) as unknown);
    return Response.json({ accepted: 1 }, { status: 202 });
  };
  const outboundFetch: typeof fetch = async input => {
    onFetch(input);
    return new Response('outbound');
  };
  const instance = createGotchuGuard({ integrationId, applicationId, secret, baseUrl: 'http://localhost:3000', fetch: fetcher, outboundFetch });
  return { instance, batches, refresh: () => instance.refreshPolicy() };
}

describe('Node runtime protection', () => {
  it('requires a valid signature, matching application, and unexpired policy', () => {
    const current = signedPolicy('block');
    expect(verifyRuntimeProtectionPolicy(current, secret, applicationId)).toEqual(current.policy);
    expect(verifyRuntimeProtectionPolicy({ ...current, signature: '0'.repeat(64) }, secret, applicationId)).toBeNull();
    expect(verifyRuntimeProtectionPolicy(current, secret, integrationId)).toBeNull();
    expect(verifyRuntimeProtectionPolicy(signedPolicy('block', [...detectors], new Date(Date.now() - 1_000).toISOString()), secret, applicationId)).toBeNull();
  });

  it('blocks only SQL structure that came from request input; SQL-like prose and parameters pass', async () => {
    const { instance } = guard();
    await instance.refreshPolicy();
    const execute = vi.fn(async () => 'ran');
    try {
      const attack = "' OR 1=1 --";
      await expect(instance.runWithContext({ route: '/users/:id', userInputs: [attack] }, () => instance.sql(`SELECT * FROM users WHERE name='${attack}'`, execute))).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      expect(execute).not.toHaveBeenCalled();
      await expect(instance.runWithContext({ route: '/notes', userInputs: ['Please select a report'] }, () => instance.sql("SELECT body FROM notes WHERE title='Please select a report'", execute))).resolves.toBe('ran');
      await expect(instance.runWithContext({ route: '/users', userInputs: [attack] }, () => instance.sql('SELECT * FROM users WHERE name=$1', execute))).resolves.toBe('ran');
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { await instance.close(); }
  });

  it('carries Express request values into wrapped sinks across async middleware work', async () => {
    const { instance } = guard();
    await instance.refreshPolicy();
    const attack = "' OR 1=1 --";
    const execute = vi.fn(async () => 'ran');
    try {
      const continued = new Promise<unknown>((resolve, reject) => {
        instance.middleware()({
          originalUrl: '/users/42?q=ignored',
          route: { path: '/users/:id' },
          params: { id: '42' },
          query: { q: attack },
          body: { note: 'ordinary text' },
        }, {}, error => {
          if (error) { reject(error); return; }
          void Promise.resolve().then(() => instance.sql(`SELECT * FROM users WHERE name='${attack}'`, execute)).then(resolve, reject);
        });
      });
      await expect(continued).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      expect(execute).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });

  it('blocks traversal only when a request path escapes its declared root', async () => {
    const { instance } = guard();
    await instance.refreshPolicy();
    const readFile = vi.fn(async (value: string) => value);
    try {
      const traversal = '../../etc/passwd';
      await expect(instance.runWithContext({ route: '/files', userInputs: [traversal] }, () => instance.filePath(traversal, '/srv/uploads', readFile))).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      expect(readFile).not.toHaveBeenCalled();
      await expect(instance.runWithContext({ route: '/files', userInputs: ['reports/2026.txt'] }, () => instance.filePath('reports/2026.txt', '/srv/uploads', readFile))).resolves.toBe('/srv/uploads/reports/2026.txt');
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally { await instance.close(); }
  });

  it('blocks shell operators flowing from input and leaves direct argument execution available', async () => {
    const { instance } = guard();
    await instance.refreshPolicy();
    const runShell = vi.fn(async () => 'ran');
    try {
      const input = '; touch /tmp/gotchu-test';
      await expect(instance.runWithContext({ route: '/search', userInputs: [input] }, () => instance.command(`echo ${input}`, runShell))).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      expect(runShell).not.toHaveBeenCalled();
      await expect(instance.runWithContext({ route: '/search', userInputs: ['select from reports'] }, () => instance.command('echo select from reports', runShell))).resolves.toBe('ran');
      expect(runShell).toHaveBeenCalledTimes(1);
    } finally { await instance.close(); }
  });

  it('blocks user-selected private and metadata destinations before fetch or http sinks', async () => {
    const outbound = vi.fn();
    const { instance } = guard('block', input => outbound(input));
    await instance.refreshPolicy();
    try {
      const metadata = 'http://169.254.169.254/latest/meta-data';
      await expect(instance.runWithContext({ route: '/proxy', userInputs: [metadata] }, () => instance.fetch(metadata))).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      const local = 'http://127.0.0.1:5432/private';
      await expect(instance.runWithContext({ route: '/proxy', userInputs: [local] }, () => instance.httpRequest(local, async () => outbound('http')))).rejects.toBeInstanceOf(GotchuProtectionBlockedError);
      expect(outbound).not.toHaveBeenCalled();
      const publicAddress = 'http://8.8.8.8/health';
      await expect(instance.runWithContext({ route: '/proxy', userInputs: [publicAddress] }, () => instance.fetch(publicAddress))).resolves.toBeInstanceOf(Response);
      expect(outbound).toHaveBeenCalledOnce();
    } finally { await instance.close(); }
  });

  it('reports monitor findings without blocking, sends only bounded metadata, and keeps the queue capped', async () => {
    const captured: Array<RequestInfo | URL> = [];
    const { instance, batches } = guard('monitor', input => captured.push(input));
    await instance.refreshPolicy();
    try {
      const input = "' OR 1=1 --";
      await expect(instance.runWithContext({ route: '/users/:id', userInputs: [input] }, () => instance.sql(`SELECT '${input}'`, async () => 'ran'))).resolves.toBe('ran');
      await instance.flush();
      const events = batches.flatMap(batch => {
        if (!batch || typeof batch !== 'object' || !('events' in batch) || !Array.isArray(batch.events)) return [];
        return batch.events;
      });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'runtime.attack_detected', outcome: 'unknown', attributes: expect.objectContaining({ attackKind: 'sql_injection', route: '/users/{id}', evidence: 'sql_boolean_tautology' }) })]));
      expect(JSON.stringify(events)).not.toContain(input);

      const burst = Array.from({ length: 150 }, (_, index) => instance.runWithContext({ route: '/users', userInputs: [input] }, () => instance.sql(`SELECT '${input}' ${index}`, async () => undefined)));
      await Promise.all(burst);
      expect(instance.status().queuedEvents).toBeLessThanOrEqual(100);
      expect(instance.status().droppedEvents).toBeGreaterThan(0);
    } finally { await instance.close(); }
  });

  it('continues the sink in monitor mode when the policy service is unavailable', async () => {
    const unavailable: typeof fetch = async (input) => String(input).endsWith('/api/v1/protection/policy')
      ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({ accepted: 1 }, { status: 202 });
    const instance = createGotchuGuard({ integrationId, applicationId, secret, baseUrl: 'http://localhost:3000', fetch: unavailable });
    const execute = vi.fn(async (value: string) => value);
    try {
      await expect(instance.runWithContext({ route: '/files', userInputs: ['../secret'] }, () => instance.filePath('../secret', '/srv/uploads', execute))).resolves.toBe('/srv/secret');
      expect(execute).toHaveBeenCalledOnce();
    } finally { await instance.close(); }
  });
});
