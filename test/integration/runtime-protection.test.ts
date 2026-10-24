import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, type CredentialStore } from '@gotchu/backend';
import { runtimeAttackKindSchema, securityEventSchema } from '@gotchu/contracts';
import { createApi } from '../../apps/web/src/server/api.js';
import { createCustomerApi } from '../../apps/web/src/server/customer-api.js';
import { processDurableJob } from '../../apps/coordinator/src/index.js';
import { createGotchuGuard, GotchuProtectionBlockedError, signEventBatch } from '../../packages/sdk/src/index.js';
import { fixture, liveUrl } from '../../packages/database/test/support.js';

const live = liveUrl ? describe : describe.skip;
const detectors = [...runtimeAttackKindSchema.options];

async function webRequest(request: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (typeof value === 'string') headers.set(key, value);
  }
  const chunks: Buffer[] = [];
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const method = request.method ?? 'GET';
  const init = body.length ? { method, headers, body: new Uint8Array(body) } : { method, headers };
  return new Request(new URL(request.url ?? '/', origin), init);
}

function forwardResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  return result.arrayBuffer().then(bytes => { response.end(Buffer.from(bytes)); });
}

live('runtime protection through a real Node app, signed HTTP intake, Postgres, and coordinator', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let apiBackend: ReturnType<typeof createBackend>;
  let intake: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let webServer: Server | undefined;
  let targetServer: Server | undefined;
  let guard: ReturnType<typeof createGotchuGuard> | undefined;
  let apiOrigin = '';
  let currentUser = '';
  let sinks = { sql: 0, filesystem: 0, child_process: 0, ssrf: 0 };
  const secret = Buffer.alloc(32, 31);

  beforeAll(async () => {
    f = await fixture({ max: 6 });
    currentUser = f.a.userId;
    const credentials: CredentialStore = {
      async getSigningSecret(reference) {
        if (reference !== `test:${f.a.integrationId}`) throw new Error('unexpected_test_credential');
        return secret;
      },
    };
    apiBackend = createBackend({ database: f.databases.gotchu_api });
    intake = createBackend({ database: f.databases.gotchu_ingest, credentials });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });

    const dispatch = createServer((incoming, outgoing) => {
      void (async () => {
        const request = await webRequest(incoming, apiOrigin);
        const handler = new URL(request.url).pathname.startsWith('/api/customer/') ? customerApi : api;
        await forwardResponse(outgoing, await handler(request));
      })().catch(() => { outgoing.statusCode = 500; outgoing.end(); });
    });
    await new Promise<void>((resolve, reject) => {
      dispatch.once('error', reject);
      dispatch.listen(0, '127.0.0.1', () => {
        const address = dispatch.address();
        if (!address || typeof address === 'string') { reject(new Error('test_server_address_missing')); return; }
        apiOrigin = `http://127.0.0.1:${address.port}`;
        webServer = dispatch;
        resolve();
      });
    });

    const api = createApi({
      origin: apiOrigin,
      auth: { enabled: false, handle: async () => new Response(), identity: async () => null, accountEmail: async () => null },
      ingest: input => intake.events.ingest(input),
      signedPolicy: input => intake.protection.signedPolicy(input),
      execute: async () => null,
    });
    const customerApi = createCustomerApi({
      origin: apiOrigin,
      auth: { enabled: true, handle: async () => new Response(), identity: async () => ({ userId: currentUser, cookies: [] }), accountEmail: async () => null },
      registrationEnabled: false,
      providers: [],
      services: { ...apiBackend.customers, protection: apiBackend.protection, job: (identity, value) => apiBackend.web.getJob(identity, value) },
    });

    sinks = { sql: 0, filesystem: 0, child_process: 0, ssrf: 0 };
    const outbound: typeof fetch = async () => new Response('ok');
    guard = createGotchuGuard({ integrationId: f.a.integrationId, applicationId: f.a.applicationId, secret, baseUrl: apiOrigin, outboundFetch: outbound });
    const target: RequestListener = (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://gotchu.invalid');
        const reply = () => { response.statusCode = 200; response.end('continued'); };
        try {
          if (url.pathname === '/sql') {
            const input = url.searchParams.get('q') ?? '';
            const statement = `SELECT * FROM users WHERE name='${input}'`;
            await guard?.sql(statement, async () => { sinks.sql++; });
          } else if (url.pathname === '/path') {
            const input = url.searchParams.get('path') ?? '';
            await guard?.filePath(input, '/srv/uploads', async () => { sinks.filesystem++; });
          } else if (url.pathname === '/command') {
            const input = url.searchParams.get('cmd') ?? '';
            await guard?.command(`echo ${input}`, async () => { sinks.child_process++; });
          } else if (url.pathname === '/ssrf') {
            const input = url.searchParams.get('url') ?? '';
            await guard?.fetch(input);
            sinks.ssrf++;
          }
          reply();
        } catch (error) {
          if (error instanceof GotchuProtectionBlockedError) { response.statusCode = 403; response.end('blocked'); return; }
          response.statusCode = 500;
          response.end('failed');
        }
      })().catch(() => { response.statusCode = 500; response.end('failed'); });
    };
    targetServer = createServer(guard.nodeHttpHandler(target));
    await new Promise<void>((resolve, reject) => {
      targetServer?.once('error', reject);
      targetServer?.listen(0, '127.0.0.1', () => resolve());
    });
  }, 30_000);

  afterAll(async () => {
    await guard?.close();
    for (const server of [webServer, targetServer]) {
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await f?.close();
  });

  it('detects, monitors, blocks, persists, isolates tenants, and emits indicative runtime alerts', async () => {
    const scope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId };
    const targetAddress = targetServer?.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target_server_address_missing');
    const targetOrigin = `http://127.0.0.1:${targetAddress.port}`;
    const makeRequest = async (pathname: string, key: string, value: string) => {
      const url = new URL(pathname, targetOrigin);
      url.searchParams.set(key, value);
      return fetch(url);
    };

    const initial = await apiBackend.protection.get({ userId: f.a.userId }, scope);
    expect(initial).toMatchObject({ mode: 'monitor', version: 0, receiving: false, enabledDetectors: detectors });
    await guard?.refreshPolicy();
    const attacks = [
      ['/sql', 'q', "' OR 1=1 --"],
      ['/path', 'path', '../../etc/passwd'],
      ['/command', 'cmd', '; touch /tmp/gotchu-runtime-protection'],
      ['/ssrf', 'url', 'http://169.254.169.254/latest/meta-data'],
    ] as const;
    for (const [pathname, key, value] of attacks) expect((await makeRequest(pathname, key, value)).status).toBe(200);
    expect(sinks).toEqual({ sql: 1, filesystem: 1, child_process: 1, ssrf: 1 });
    await guard?.flush();

    const received = await apiBackend.protection.get({ userId: f.a.userId }, scope);
    expect(received.receiving).toBe(true);
    expect(received.lastEventAt).not.toBeNull();
    const monitorEvents = await apiBackend.protection.listDetections({ userId: f.a.userId }, scope);
    expect(monitorEvents).toHaveLength(4);
    expect(monitorEvents.every(event => event.outcome === 'unknown')).toBe(true);

    currentUser = f.a.userId;
    const writeConfig = (mode: 'monitor' | 'block') => fetch(`${apiOrigin}/api/customer/workspaces/${scope.organizationId}/applications/${scope.applicationId}/protection`, {
      method: 'PUT', headers: { origin: apiOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ mode, enabledDetectors: detectors }),
    });
    const saved = await writeConfig('block');
    const savedText = await saved.text();
    expect(saved.status, savedText).toBe(200);
    expect(JSON.parse(savedText)).toMatchObject({ mode: 'block', version: 1 });
    await guard?.refreshPolicy();
    const countsBeforeBlock = { ...sinks };
    for (const [pathname, key, value] of attacks) expect((await makeRequest(pathname, key, value)).status).toBe(403);
    expect(sinks).toEqual(countsBeforeBlock);
    await guard?.flush();

    const detections = await apiBackend.protection.listDetections({ userId: f.a.userId }, scope);
    expect(detections).toHaveLength(8);
    expect(detections.filter(event => event.outcome === 'blocked')).toHaveLength(4);
    const sanitized = await f.admin.query<{ attack_kind: string; route: string; outcome: string; evidence: string }>(`SELECT attack_kind,route,outcome,evidence FROM gotchu.runtime_protection_events
      WHERE organization_id=$1 AND application_id=$2 AND kind='attack' ORDER BY received_at,event_id`, [scope.organizationId, scope.applicationId]);
    expect(sanitized.rows).toHaveLength(8);
    expect(JSON.stringify(sanitized.rows)).not.toMatch(/OR 1=1|passwd|touch|169\.254/);

    await expect(apiBackend.protection.get({ userId: f.b.userId }, scope)).rejects.toMatchObject({ code: 'forbidden' });
    currentUser = f.b.userId;
    expect((await writeConfig('monitor')).status).toBe(403);
    const viewerId = `github:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [scope.organizationId, viewerId]);
    currentUser = viewerId;
    expect((await writeConfig('monitor')).status).toBe(403);
    currentUser = f.a.userId;

    const stored = await f.admin.query<{ payload: unknown }>(`SELECT payload FROM gotchu.events WHERE organization_id=$1 AND application_id=$2
      AND payload->>'type'='runtime.attack_detected' ORDER BY received_at LIMIT 1`, [scope.organizationId, scope.applicationId]);
    const original = securityEventSchema.parse(stored.rows[0]?.payload);
    const resend = async (applicationId: string, events: typeof original[]) => {
      const signed = signEventBatch({ integrationId: f.a.integrationId, secret, batch: { applicationId, events } });
      return fetch(`${apiOrigin}/api/v1/events`, { method: 'POST', headers: signed.headers, body: signed.body });
    };
    const duplicate = await resend(scope.applicationId, [original]);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const altered = securityEventSchema.parse({ ...original, outcome: original.outcome === 'blocked' ? 'unknown' : 'blocked' });
    expect((await resend(scope.applicationId, [altered])).status).toBe(409);
    expect((await resend(f.b.applicationId, [original])).status).toBe(403);

    const jobs = await f.admin.query<{ id: string }>(`SELECT DISTINCT job_id AS id FROM gotchu.events
      WHERE organization_id=$1 AND application_id=$2 AND payload->>'type'='runtime.attack_detected' ORDER BY id`, [scope.organizationId, scope.applicationId]);
    for (const job of jobs.rows) await processDurableJob({ database: f.databases.gotchu_coordinator, backend: coordinator }, {
      version: 1, id: job.id, ...scope, kind: 'events.aggregate',
    });
    const alerts = await apiBackend.operations.listAlerts({ userId: f.a.userId }, scope);
    const runtimeAlerts = alerts.filter(alert => alert.observation.kind === 'security_finding' && alert.observation.summary.includes('runtime indications'));
    expect(runtimeAlerts).toHaveLength(4);
    expect(runtimeAlerts.every(alert => alert.observation.summary.includes('2 runtime indications') && alert.observation.summary.includes('1 attempts were blocked')
      && alert.observation.severity === 'medium')).toBe(true);
    expect(runtimeAlerts.every(alert => !/compromise confirmed|exploitation confirmed/i.test(alert.observation.summary))).toBe(true);
  }, 15_000);
});
