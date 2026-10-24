import { createHmac, randomUUID } from 'node:crypto';
import { eventBatchSchema, idSchema, securityEventSchema, type EventBatchInput } from '@gotchu/contracts';

/** Use a route template (e.g. /orders/:id), never a request body, query, cookie or raw stack. */
export function httpRequestEvent(input: { route: string; statusCode: number; durationMs: number; capacityUtilization?: number }) {
  if (!/^\/[^?#\x00-\x1f\x7f]{0,255}$/.test(input.route) || !Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599
    || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 3_600_000
    || input.capacityUtilization !== undefined && (!Number.isFinite(input.capacityUtilization) || input.capacityUtilization < 0 || input.capacityUtilization > 1)) throw new Error('Invalid bounded request metrics');
  return securityEventSchema.parse({ id: randomUUID(), source: 'application', type: 'http.request', occurredAt: new Date().toISOString(),
    outcome: input.statusCode >= 500 ? 'failure' : 'success', resource: { type: 'route', id: input.route },
    attributes: { statusCode: input.statusCode, durationMs: input.durationMs, ...(input.capacityUtilization !== undefined ? { capacityUtilization: input.capacityUtilization } : {}) } });
}

export function applicationErrorEvent(category: 'exception' | 'database' | 'upstream' | 'memory' | 'timeout' | 'configuration' | 'unknown') {
  if (!['exception', 'database', 'upstream', 'memory', 'timeout', 'configuration', 'unknown'].includes(category)) throw new Error('Unsupported error category');
  return securityEventSchema.parse({ id: randomUUID(), source: 'application', type: 'app.error', occurredAt: new Date().toISOString(), outcome: 'failure', attributes: { category } });
}

export function signEventBatch(input: { integrationId: string; secret: Uint8Array; batch: EventBatchInput; timestamp?: number }) {
  const integrationId = idSchema.parse(input.integrationId);
  if (input.secret.byteLength < 32) throw new Error('An integration signing key must contain at least 32 bytes');
  const seconds = Math.floor(input.timestamp ?? Date.now() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Signing timestamp must be finite Unix seconds');
  const timestamp = String(seconds);
  const batch = eventBatchSchema.parse(input.batch);
  if (batch.events.some((event) => event.source !== 'application')) throw new Error('The Node SDK only emits application events');
  const body = JSON.stringify(batch);
  const signature = createHmac('sha256', input.secret)
    .update(`gotchu-events-v1\n${integrationId}\n${timestamp}\n`).update(body).digest('hex');
  return { body, headers: {
    'Content-Type': 'application/json',
    'X-Gotchu-Integration': integrationId,
    'X-Gotchu-Timestamp': timestamp,
    'X-Gotchu-Signature': signature,
  } };
}

export async function sendEventBatch(input: {
  baseUrl: string;
  integrationId: string;
  secret: Uint8Array;
  batch: EventBatchInput;
  signal?: AbortSignal;
}, dependencies: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<unknown> {
  const base = new URL(input.baseUrl);
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('Use HTTPS for security event delivery outside local development');
  }
  const request = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const batch = eventBatchSchema.parse(input.batch);
  for (let attempt = 0; attempt < 3; attempt++) {
    input.signal?.throwIfAborted();
    const signed = signEventBatch({ ...input, batch, timestamp: dependencies.now?.() ?? Date.now() / 1000 });
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    let retryDelay = Math.min(500 * 2 ** attempt, 5000);
    try {
      const response = await request(new URL('/api/v1/events', base), { method: 'POST', headers: signed.headers, body: signed.body, signal, redirect: 'error' });
      if (response.status === 202) return await response.json();
      if (![429, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        throw new PermanentDeliveryError(`Event batch rejected with HTTP ${response.status}`);
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryDelay = Math.min(retryAfter * 1000, 5000);
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof PermanentDeliveryError || input.signal?.aborted) throw error;
    }
    if (attempt < 2) await sleep(retryDelay);
  }
  throw new Error('Event delivery failed after three bounded attempts; this batch was not acknowledged');
}

export { createGotchuGuard, GotchuProtectionBlockedError, verifyRuntimeProtectionPolicy } from './protection.js';

class PermanentDeliveryError extends Error {}
