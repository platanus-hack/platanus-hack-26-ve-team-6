import { describe, expect, it } from 'vitest';
import { readBoundedBody, requireSameOrigin, errorResponse } from '../src/server/http.js';

describe('HTTP input boundary', () => {
  it('exposes a monitoring archive fence as a conflict without exposing arbitrary database errors', async () => {
    const response = errorResponse(Object.assign(new Error('monitor_work_in_progress'), { code: 'P0001' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'monitor_work_in_progress' } });
    const other = errorResponse(Object.assign(new Error('private database detail'), { code: 'P0001' }));
    expect(other.status).toBe(500); expect(await other.text()).not.toContain('private database detail');
  });
  it('limits streamed bytes even when Content-Length is absent', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(12)); controller.enqueue(new Uint8Array(12)); },
      cancel() { cancelled = true; },
    });
    const init = { method: 'POST', body, duplex: 'half' } satisfies RequestInit & { duplex: 'half' };
    const request = new Request('http://localhost/events', init);
    await expect(readBoundedBody(request, 20)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it('cancels a stalled event body instead of retaining the request indefinitely', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init = { method: 'POST', body, duplex: 'half' } satisfies RequestInit & { duplex: 'half' };
    await expect(readBoundedBody(new Request('http://localhost/events', init), 1024, 10)).rejects.toMatchObject({ status: 408 });
    expect(cancelled).toBe(true);
  });

  it('preserves exact signed bytes instead of parsing and reserializing them', async () => {
    const original = Buffer.from('{ "events" : [] }\n');
    expect(await readBoundedBody(new Request('http://localhost/events', { method: 'POST', body: original }))).toEqual(original);
  });

  it('requires the exact configured Origin for cookie-authenticated mutations', () => {
    const origin = 'https://gotchu.example';
    expect(() => requireSameOrigin(new Request(`${origin}/api/approve`, { method: 'POST', headers: { origin: 'https://attacker.example' } }), origin)).toThrow();
    expect(() => requireSameOrigin(new Request(`${origin}/api/approve`, { method: 'POST' }), origin)).toThrow();
    expect(() => requireSameOrigin(new Request(`${origin}/api/approve`, { method: 'POST', headers: { origin } }), origin)).not.toThrow();
  });
});
