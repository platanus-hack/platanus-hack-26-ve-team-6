import { describe, expect, it } from 'vitest';
import { readBoundedBody, requireSameOrigin } from '../src/server/http.js';

describe('HTTP input boundary', () => {
  it('limits streamed bytes even when Content-Length is absent', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(12)); controller.enqueue(new Uint8Array(12)); },
      cancel() { cancelled = true; },
    });
    const request = new Request('http://localhost/events', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readBoundedBody(request, 20)).rejects.toMatchObject({ status: 413 });
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
