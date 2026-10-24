import { AsyncLocalStorage } from 'node:async_hooks';
import { exec as execCallback, execFile as execFileCallback, spawn as spawnCallback } from 'node:child_process';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { promisify } from 'node:util';
import {
  eventBatchSchema, idSchema, runtimeAttackEventAttributesSchema,
  runtimeAttackKindSchema, runtimeProtectionPolicySchema, securityEventSchema,
  signedRuntimeProtectionPolicySchema, type EventBatchInput, type RuntimeProtectionPolicy, type SecurityEvent,
} from '@gotchu/contracts';
import { sendEventBatch } from './index.js';
import { canonicalJson, inputFlowsInto, outsideRoot, requestRoute, requestValues, resolvesPrivate, routeTemplate, shellEvidence, sqlEvidence, type AttackKind, type Evidence } from './protection-detectors.js';

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const allDetectors = runtimeAttackKindSchema.options;
const policyCacheMs = 10_000;
const queueLimit = 100;
const eventFlushSize = 20;
const timeoutMs = 1_500;
const blockedMessage = 'Request blocked by Gotchu runtime protection';
type Sink = 'sql' | 'filesystem' | 'child_process' | 'fetch' | 'http';
type RequestContext = { route: string; userInputs: readonly string[] };
type ExpressLikeRequest = {
  originalUrl?: string;
  url?: string;
  route?: { path?: string | readonly string[] };
  params?: unknown;
  query?: unknown;
  body?: unknown;
};
type ExpressLikeMiddleware = (request: ExpressLikeRequest, response: unknown, next: (error?: unknown) => void) => void;
type GuardOptions = {
  integrationId: string;
  applicationId: string;
  secret: Uint8Array;
  baseUrl: string;
  fetch?: typeof fetch;
  outboundFetch?: typeof fetch;
  policyCacheMs?: number;
};
const context = new AsyncLocalStorage<RequestContext>();
const nowIso = () => new Date().toISOString();

export class GotchuProtectionBlockedError extends Error {
  constructor(readonly attackKind: AttackKind) {
    super(blockedMessage);
    this.name = 'GotchuProtectionBlockedError';
  }
}

export function verifyRuntimeProtectionPolicy(input: unknown, secret: Uint8Array, applicationId: string, currentTime = Date.now()): RuntimeProtectionPolicy | null {
  const parsed = signedRuntimeProtectionPolicySchema.safeParse(input);
  if (!parsed.success || secret.byteLength < 32) return null;
  const expected = createHmac('sha256', secret).update(`gotchu-runtime-policy-v1\n${canonicalJson(parsed.data.policy)}`).digest();
  const supplied = Buffer.from(parsed.data.signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return null;
  const policy = runtimeProtectionPolicySchema.parse(parsed.data.policy);
  if (policy.applicationId !== applicationId || Date.parse(policy.expiresAt) <= currentTime || Date.parse(policy.issuedAt) > currentTime + 30_000) return null;
  return policy;
}

export function createGotchuGuard(options: GuardOptions) {
  const integrationId = idSchema.parse(options.integrationId);
  const applicationId = idSchema.parse(options.applicationId);
  if (options.secret.byteLength < 32) throw new Error('Integration secret must contain at least 32 bytes');
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.username || baseUrl.password || (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)))) {
    throw new Error('Use HTTPS for Gotchu outside local development');
  }
  const controlFetch = options.fetch ?? fetch;
  const outboundFetch = options.outboundFetch ?? fetch;
  const cacheMs = Math.max(1_000, Math.min(options.policyCacheMs ?? policyCacheMs, 30_000));
  const events: SecurityEvent[] = [];
  let droppedEvents = 0;
  let policy: RuntimeProtectionPolicy | null = null;
  let fetchedAt = 0;
  let refresh: Promise<void> | null = null;
  let flushing: Promise<void> | null = null;

  function fallbackPolicy(): RuntimeProtectionPolicy {
    const issuedAt = nowIso();
    return { applicationId, mode: 'monitor', enabledDetectors: [...allDetectors], issuedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  function queue(event: SecurityEvent): void {
    if (events.length >= queueLimit) { droppedEvents++; return; }
    events.push(event);
    if (events.length >= eventFlushSize) flush().catch(() => undefined);
  }

  function report(kind: AttackKind, sink: Sink, evidence: Evidence, outcome: 'blocked' | 'unknown'): void {
    try {
      const attributes = runtimeAttackEventAttributesSchema.parse({ attackKind: kind, sink, evidence,
        route: routeTemplate(context.getStore()?.route ?? '/unknown') });
      queue(securityEventSchema.parse({ id: randomUUID(), source: 'application', type: 'runtime.attack_detected',
        occurredAt: nowIso(), outcome, attributes }));
    } catch { /* Detection reporting must never change application behavior. */ }
  }

  async function refreshPolicy(): Promise<void> {
    if (refresh) return refresh;
    refresh = (async () => {
      fetchedAt = Date.now();
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac('sha256', options.secret).update(`gotchu-protection-policy-request-v1\n${integrationId}\n${timestamp}\n`).digest('hex');
        const response = await controlFetch(new URL('/api/v1/protection/policy', baseUrl), {
          headers: { 'X-Gotchu-Integration': integrationId, 'X-Gotchu-Timestamp': timestamp, 'X-Gotchu-Signature': signature },
          signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        });
        if (!response.ok) { policy = null; await response.body?.cancel(); return; }
        const payload: unknown = await response.json();
        policy = verifyRuntimeProtectionPolicy(payload, options.secret, applicationId);
      } catch { /* A missed policy refresh leaves only a still-valid cache; otherwise monitor mode applies. */ }
    })().finally(() => { refresh = null; });
    return refresh;
  }

  function currentPolicy(): RuntimeProtectionPolicy {
    if (policy && Date.parse(policy.expiresAt) > Date.now()) {
      if (Date.now() - fetchedAt >= cacheMs) refreshPolicy().catch(() => undefined);
      return policy;
    }
    if (Date.now() - fetchedAt >= cacheMs) refreshPolicy().catch(() => undefined);
    return fallbackPolicy();
  }

  function inspect(kind: AttackKind, sink: Sink, evidence: Evidence, sinkArgument: string): boolean {
    const request = context.getStore();
    if (!request || !inputFlowsInto(sinkArgument, request.userInputs)) return false;
    const current = currentPolicy();
    if (!current.enabledDetectors.includes(kind)) return false;
    const blocked = current.mode === 'block';
    report(kind, sink, evidence, blocked ? 'blocked' : 'unknown');
    return blocked;
  }

  async function inspectUrl(input: string | URL, sink: 'fetch' | 'http'): Promise<boolean> {
    const targetText = input.toString();
    const request = context.getStore();
    if (!request || !inputFlowsInto(targetText, request.userInputs)) return false;
    let target: URL;
    try { target = new URL(targetText); } catch { return false; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (!await resolvesPrivate(target.hostname)) return false;
    return inspect('ssrf', sink, 'private_destination', targetText);
  }

  async function flush(): Promise<void> {
    if (flushing) return flushing;
    if (!events.length) return;
    const batchEvents = events.splice(0, queueLimit);
    const batch: EventBatchInput = eventBatchSchema.parse({ applicationId, events: batchEvents });
    flushing = sendEventBatch({ baseUrl: baseUrl.origin, integrationId, secret: options.secret, batch, signal: AbortSignal.timeout(3_000) }, { fetch: controlFetch })
      .then(() => undefined)
      .catch(() => {
        const room = Math.max(0, queueLimit - events.length);
        events.unshift(...batchEvents.slice(0, room));
        droppedEvents += batchEvents.length - room;
      })
      .finally(() => { flushing = null; });
    return flushing;
  }

  function runWithContext<T>(request: { route: string; userInputs: readonly string[] }, callback: () => T): T {
    const userInputs = request.userInputs.filter(value => typeof value === 'string').slice(0, 128);
    return context.run({ route: routeTemplate(request.route), userInputs }, callback);
  }

  function middleware(): ExpressLikeMiddleware {
    return (request, _response, next) => {
      const rawUrl = request.originalUrl ?? request.url ?? '/';
      const path = Array.isArray(request.route?.path) ? request.route.path[0] : request.route?.path;
      const route = typeof path === 'string' ? path : requestRoute(rawUrl);
      const inputs = requestValues(rawUrl, [request.params, request.query, request.body]);
      try { runWithContext({ route, userInputs: inputs }, () => next()); }
      catch (error) { next(error); }
    };
  }

  function nodeHttpHandler(handler: RequestListener): RequestListener {
    return (request, response) => {
      const rawUrl = request.url ?? '/';
      runWithContext({ route: requestRoute(rawUrl), userInputs: requestValues(rawUrl) }, () => handler(request, response));
    };
  }

  const heartbeat = () => {
    try {
      queue(securityEventSchema.parse({ id: randomUUID(), type: 'runtime.protection_heartbeat', source: 'application',
        occurredAt: nowIso(), outcome: 'success', attributes: { sdk: 'node', guardInstalled: true } }));
    } catch { /* A health signal must not affect the application. */ }
  };
  heartbeat();
  refreshPolicy().catch(() => undefined);
  let lastHeartbeat = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastHeartbeat >= 60_000) { heartbeat(); lastHeartbeat = Date.now(); }
    flush().catch(() => undefined);
  }, 1_000);
  timer.unref();
  flush().catch(() => undefined);

  const guard = {
    runWithContext,
    middleware,
    nodeHttpHandler,
    async sql<T>(query: string, execute: () => T | Promise<T>): Promise<T> {
      const inputs = context.getStore()?.userInputs ?? [];
      for (const input of inputs) {
        const evidence = sqlEvidence(input);
        if (evidence && query.includes(input) && inspect('sql_injection', 'sql', evidence, query)) throw new GotchuProtectionBlockedError('sql_injection');
      }
      return execute();
    },
    async filePath<T>(requestedPath: string, root: string, executePath: (resolvedPath: string) => T | Promise<T>): Promise<T> {
      const resolved = path.resolve(root, requestedPath);
      const inputs = context.getStore()?.userInputs ?? [];
      if (outsideRoot(requestedPath, root) && inputs.some(input => input.length > 0 && requestedPath.includes(input))
        && inspect('path_traversal', 'filesystem', 'path_outside_root', requestedPath)) throw new GotchuProtectionBlockedError('path_traversal');
      return executePath(resolved);
    },
    async command<T>(command: string, executeCommand: () => T | Promise<T>): Promise<T> {
      const inputs = context.getStore()?.userInputs ?? [];
      for (const input of inputs) {
        const evidence = shellEvidence(input);
        if (evidence && command.includes(input) && inspect('command_injection', 'child_process', evidence, command)) throw new GotchuProtectionBlockedError('command_injection');
      }
      return executeCommand();
    },
    async exec(command: string, options?: Parameters<typeof exec>[1]) {
      return guard.command(command, () => exec(command, options));
    },
    async execFile(command: string, args: readonly string[] = [], options?: Parameters<typeof execFile>[2]) {
      const shellEnabled = typeof options === 'object' && options !== null && 'shell' in options && Boolean(options.shell);
      if (!shellEnabled) return execFile(command, [...args], options);
      const commandLine = [command, ...args].join(' ');
      return guard.command(commandLine, () => execFile(command, [...args], options));
    },
    async spawn(command: string, args: readonly string[] = [], options?: Parameters<typeof spawnCallback>[2]) {
      const commandLine = [command, ...args].join(' ');
      if (!options?.shell) return options ? spawnCallback(command, [...args], options) : spawnCallback(command, [...args]);
      return guard.command(commandLine, () => spawnCallback(command, [...args], options));
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const target = input instanceof Request ? input.url : input instanceof URL ? input : String(input);
      if (await inspectUrl(target, 'fetch')) throw new GotchuProtectionBlockedError('ssrf');
      return outboundFetch(input, { ...init, redirect: 'error' });
    },
    async httpRequest<T>(input: string | URL, executeRequest: () => T | Promise<T>): Promise<T> {
      if (await inspectUrl(input, 'http')) throw new GotchuProtectionBlockedError('ssrf');
      return executeRequest();
    },
    refreshPolicy,
    flush,
    status() { return { queuedEvents: events.length, droppedEvents }; },
    async close() { clearInterval(timer); await flush(); },
  };
  return guard;
}
