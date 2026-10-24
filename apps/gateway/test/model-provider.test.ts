import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investigationModelProviderForPreset, investigationProviderCatalog } from '@gotchu/contracts';
import { createModelPort } from '../src/model-provider.js';
import { redactEvidenceExcerpt } from '../src/service.js';

const providerHosts = investigationProviderCatalog.flatMap(preset => preset.baseUrl ? [new URL(preset.baseUrl).hostname] : ['custom.example']);
const fixtureBody = { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } };
const recorded: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
let server: ReturnType<typeof createHttpsServer>;
let serverPort = 0;
let certificate = '';
let tempDirectory = '';

beforeAll(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-provider-preset-'));
  const keyPath = join(tempDirectory, 'key.pem');
  const certificatePath = join(tempDirectory, 'cert.pem');
  const san = [...new Set(providerHosts)].map(host => `DNS:${host}`).join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=gotchu-provider-fixture', '-addext', `subjectAltName=${san}`, '-keyout', keyPath, '-out', certificatePath], { stdio: 'ignore', timeout: 10_000 });
  const [privateKey, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certificatePath, 'utf8')]);
  certificate = cert;
  server = createHttpsServer({ key: privateKey, cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      recorded.push({ url: request.url ?? '', method: request.method ?? '', headers, body: Buffer.concat(chunks).toString('utf8') });
      const payload = request.url?.endsWith('/messages')
        ? { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 9, output_tokens: 2 } }
        : fixtureBody;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local HTTPS fixture did not bind');
  serverPort = address.port;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

function localTlsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = input instanceof URL ? input : typeof input === 'string' ? input : input.url;
  const target = new URL(rawUrl);
  const requestHeaders = new Headers(init?.headers);
  requestHeaders.set('host', target.hostname);
  const outgoingHeaders: Record<string, string> = {};
  requestHeaders.forEach((value, name) => { outgoingHeaders[name] = value; });
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: '127.0.0.1', port: serverPort, method: init?.method ?? 'GET', path: target.pathname,
      headers: outgoingHeaders, ca: certificate, rejectUnauthorized: true, servername: target.hostname,
      checkServerIdentity: (_hostname, peerCertificate) => checkServerIdentity(target.hostname, peerCertificate),
      ...(init?.signal ? { signal: init.signal } : {}),
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }));
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    if (typeof init?.body === 'string') request.write(init.body);
    request.end();
  });
}

describe('hosted investigator provider adapters (local HTTPS fixtures; not live-provider evidence)', () => {
  it('redacts secrets in structured values before they enter model requests', () => {
    const canary = 'canary-secret-DO_NOT_LEAK-8321';
    const excerpt = redactEvidenceExcerpt({ source: 'code', environment: { api_key: canary, safe: `const config = {"api_key":"${canary}"};` } });
    expect(excerpt).not.toContain(canary);
    expect(excerpt).toContain('[REDACTED]');
  });

  it.each(investigationProviderCatalog)('sends the exact HTTPS request for $displayName and parses usage', async preset => {
    recorded.length = 0;
    const endpoint = new URL(preset.baseUrl ?? 'https://custom.example/v1');
    const modelId = preset.defaultModelId ?? 'fixture-model';
    const systemInstruction = 'Return a JSON object only.';
    const userContext = 'Bounded fixture input.';
    const result = await createModelPort({ fetchImpl: localTlsFetch }).complete({
      provider: investigationModelProviderForPreset(preset), providerPresetId: preset.id, endpoint, modelId,
      apiKey: 'fixture-provider-key', systemInstruction, userContext,
      maxOutputTokens: 16, signal: AbortSignal.timeout(2_000),
    });

    const suffix = preset.adapterKind === 'anthropic' ? 'messages' : 'chat/completions';
    const base = endpoint.href.endsWith('/') ? endpoint.href : `${endpoint.href}/`;
    const expectedUrl = new URL(suffix, base);
    const request = recorded[0];
    expect(recorded).toHaveLength(1);
    expect(request).toBeDefined();
    expect(`https://${request?.headers.get('host')}${request?.url}`).toBe(expectedUrl.href);
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('accept')).toBe('application/json');
    if (preset.authHeaderStyle === 'anthropic_messages') {
      expect(request?.headers.get('x-api-key')).toBe('fixture-provider-key');
      expect(request?.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(request?.headers.has('authorization')).toBe(false);
      expect(JSON.parse(request?.body ?? '')).toEqual({
        model: modelId, system: systemInstruction, messages: [{ role: 'user', content: userContext }], max_tokens: 16,
      });
    } else {
      expect(request?.headers.get('authorization')).toBe('Bearer fixture-provider-key');
      expect(JSON.parse(request?.body ?? '')).toEqual({
        model: modelId, messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userContext }],
        [preset.maxTokensField]: 16, stream: false,
        ...(preset.supportsJsonObjectMode && [preset.defaultModelId, ...preset.suggestedModelIds].some(suggestedModelId => suggestedModelId === modelId)
          ? { response_format: { type: 'json_object' } } : {}),
      });
      expect(request?.body).not.toContain('fixture-provider-key');
    }
    expect(result).toEqual({ output: {}, inputTokens: 9, outputTokens: 2 });
  });
});
