import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createGotchuGuard,
  GotchuProtectionBlockedError,
  httpRequestEvent,
  sendEventBatch,
} from '@gotchu/sdk';
import type { EventBatchInput } from '@gotchu/contracts';

export type EvaluationFault =
  | 'bad_release'
  | 'provider_outage'
  | 'dependency_latency'
  | 'cpu_pressure'
  | 'memory_pressure'
  | 'event_loop_pressure'
  | 'traffic_spike'
  | 'credential_stuffing'
  | 'sql_injection'
  | 'path_traversal'
  | 'stale_telemetry'
  | 'missing_telemetry';

type FaultOptions = { dependentRouteFails?: boolean; dependencyLatencyMs?: number; authIp?: string };

export interface EvaluationTargetOptions {
  integrationId: string;
  applicationId: string;
  secret: Uint8Array;
  telemetryUrl: string;
  service: string;
  release: string;
}

export async function startTriageEvaluationTarget(options: EvaluationTargetOptions) {
  const guard = createGotchuGuard({
    integrationId: options.integrationId,
    applicationId: options.applicationId,
    secret: options.secret,
    baseUrl: options.telemetryUrl,
  });
  let release = options.release;
  let telemetryAt: string | undefined;
  let faults = new Set<EvaluationFault>();
  let dependentRouteFails = false;
  let dependencyLatencyMs = 0;
  let authIp = '192.0.2.55';
  let accountSequence = 0;
  let eventLoopFaultPending = false;
  const pending: EventBatchInput['events'] = [];
  const sinkExecutions = { sql: 0, filesystem: 0 };

  function queue(event: EventBatchInput['events'][number]) {
    pending.push(event);
  }

  function inject(nextFaults: readonly EvaluationFault[], faultOptions: FaultOptions = {}) {
    faults = new Set(nextFaults);
    dependentRouteFails = faultOptions.dependentRouteFails ?? false;
    dependencyLatencyMs = faultOptions.dependencyLatencyMs ?? 0;
    authIp = faultOptions.authIp ?? '192.0.2.55';
    eventLoopFaultPending = faults.has('event_loop_pressure');
  }

  function requestMetrics(request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1], startedAt: number) {
    response.once('finish', () => {
      const path = new URL(request.url ?? '/', 'http://gotchu-evaluation.invalid').pathname;
      const route = path === '/' || path === '/.well-known/security.txt' || path === '/healthz'
        ? path
        : path.startsWith('/attack/') ? '/attack/{sink}'
          : path === '/login' ? '/login'
            : path === '/dependent' ? '/dependent'
              : path === '/checkout' ? '/checkout'
                : '/work';
      const event = httpRequestEvent({
        route,
        statusCode: response.statusCode,
        durationMs: Math.min(3_600_000, Math.max(0, performance.now() - startedAt)),
        capacityUtilization: faults.has('cpu_pressure') || faults.has('memory_pressure') ? 0.95 : 0.3,
      });
      queue({
        ...event,
        ...(telemetryAt ? { occurredAt: telemetryAt } : {}),
        attributes: { ...event.attributes, service: options.service, release, route },
      });
    });
  }

  const handler: RequestListener = guard.nodeHttpHandler((request, response) => {
    const startedAt = performance.now();
    requestMetrics(request, response, startedAt);
    const path = new URL(request.url ?? '/', 'http://gotchu-evaluation.invalid').pathname;
    const reply = (statusCode: number, body: string) => response.writeHead(statusCode, { 'content-type': 'text/plain' }).end(body);
    void (async () => {
      if (request.method !== 'GET') { reply(405, 'method not allowed'); return; }
      if (path === '/healthz' || path === '/.well-known/security.txt') { reply(200, 'healthy'); return; }
      if (path === '/') {
        if (dependencyLatencyMs > 0) await delay(dependencyLatencyMs);
        reply(dependentRouteFails ? 503 : 200, dependentRouteFails ? 'dependency unavailable' : 'healthy');
        return;
      }
      if (path === '/dependent') {
        if (dependencyLatencyMs > 0) await delay(dependencyLatencyMs);
        reply(dependentRouteFails ? 503 : 200, dependentRouteFails ? 'dependency unavailable' : 'healthy');
        return;
      }
      if (path === '/checkout' || path === '/work') {
        if (path === '/checkout' && faults.has('bad_release')) { reply(503, 'injected release failure'); return; }
        if (path === '/work' && eventLoopFaultPending) {
          eventLoopFaultPending = false;
          const until = performance.now() + 1_050;
          while (performance.now() < until) { /* bounded local event-loop fault */ }
        }
        reply(200, 'ok');
        return;
      }
      if (path === '/login') {
        accountSequence++;
        queue({ id: randomUUID(), type: 'auth.login_failed', source: 'application',
          occurredAt: telemetryAt ?? new Date().toISOString(), outcome: 'failure',
          actor: { accountId: `eval-account-${accountSequence % 6}`, ip: authIp }, attributes: {} });
        reply(401, 'authentication failed');
        return;
      }
      if (path === '/attack/sql') {
        const queryValue = new URL(request.url ?? '/', 'http://gotchu-evaluation.invalid').searchParams.get('value') ?? '';
        const statement = `SELECT * FROM users WHERE name='${queryValue}'`;
        await guard.sql(statement, async () => { sinkExecutions.sql++; });
        reply(200, 'query executed');
        return;
      }
      if (path === '/attack/path') {
        const requestedPath = new URL(request.url ?? '/', 'http://gotchu-evaluation.invalid').searchParams.get('path') ?? '';
        await guard.filePath(requestedPath, '/tmp/gotchu-evaluation-uploads', async () => { sinkExecutions.filesystem++; });
        reply(200, 'file read');
        return;
      }
      reply(404, 'not found');
    })().catch(error => {
      if (error instanceof GotchuProtectionBlockedError) { reply(403, 'blocked by runtime protection'); return; }
      reply(500, 'target failure');
    });
  });

  const server: Server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000, maxHeaderSize: 8_192 }, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('evaluation_target_listener_missing');

  async function flush() {
    await guard.flush();
    while (pending.length) {
      const events = pending.splice(0, 100);
      await sendEventBatch({ baseUrl: options.telemetryUrl, integrationId: options.integrationId,
        secret: options.secret, batch: { applicationId: options.applicationId, events } });
    }
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    handler,
    sinkExecutions,
    inject,
    refreshPolicy: guard.refreshPolicy,
    setRelease(value: string) { release = value; },
    setTelemetryTime(value?: string) { telemetryAt = value; },
    async emitResourcePressure(kind: 'cpu' | 'memory' | 'event_loop') {
      let allocations: Buffer[] = [];
      if (kind === 'memory') allocations = Array.from({ length: 5 }, () => Buffer.alloc(6 * 1024 * 1024, 0xff));
      for (let sample = 0; sample < 5; sample++) {
        const before = process.cpuUsage();
        const start = performance.now();
        if (kind === 'cpu') {
          const until = start + 25;
          while (performance.now() < until) { /* bounded local CPU fault */ }
        }
        const elapsed = Math.max(1, performance.now() - start);
        const cpu = process.cpuUsage(before);
        const cpuUtilization = Math.min(1, (cpu.user + cpu.system) / (elapsed * 1_000));
        const attributes = kind === 'cpu'
          ? { cpuUtilization }
          : kind === 'memory'
            ? { memoryUtilization: Math.min(0.99, process.memoryUsage().rss / (64 * 1024 * 1024)) }
            : { eventLoopDelayMs: 1_050 };
        queue({ id: randomUUID(), type: 'runtime.resource', source: 'application',
          occurredAt: telemetryAt ?? new Date().toISOString(), outcome: 'unknown', attributes });
      }
      allocations = [];
    },
    emitHeartbeat() {
      queue({ id: randomUUID(), type: 'monitor.heartbeat', source: 'application',
        occurredAt: telemetryAt ?? new Date().toISOString(), outcome: 'success', attributes: {} });
    },
    flush,
    async close() {
      await flush();
      await guard.close();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
