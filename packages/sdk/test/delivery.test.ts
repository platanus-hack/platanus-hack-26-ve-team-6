import { describe, expect, it } from 'vitest';
import { sendEventBatch, signEventBatch } from '../src/index.js';

const input = {
  baseUrl: 'http://localhost:3000',
  integrationId: '2b30cde0-2730-4576-8c7b-e30e82ac9860',
  secret: new Uint8Array(32).fill(7),
  batch: { applicationId: '3d17e846-c37c-4e36-8aa2-a72bfb42d709', events: [{ id: 'cc5b8ac6-6111-4dd6-aeab-9577af82abc9', type: 'auth.login_failed' as const, source: 'application' as const, occurredAt: '2026-10-24T00:00:00.000Z', outcome: 'failure' as const }] },
};

describe('bounded signed event delivery', () => {
  it('retries the same event identities and bytes while refreshing the signature timestamp', async () => {
    const attempts: RequestInit[] = [];
    let clock = 100;
    const result = await sendEventBatch(input, {
      now: () => clock++, sleep: async () => {},
      fetch: async (_url, init) => {
        attempts.push(init!);
        return attempts.length === 1 ? new Response(null, { status: 503 }) : Response.json({ accepted: 1 }, { status: 202 });
      },
    });
    expect(result).toEqual({ accepted: 1 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
    expect(new Headers(attempts[0]?.headers).get('x-gotchu-timestamp')).not.toBe(new Headers(attempts[1]?.headers).get('x-gotchu-timestamp'));
    expect(JSON.stringify(attempts)).not.toContain(Buffer.from(input.secret).toString('base64'));
  });

  it('does not retry a permanent rejection and bounds overload retries', async () => {
    let count = 0;
    const permanent = async () => { count++; return new Response(null, { status: 401 }); };
    await expect(sendEventBatch(input, { fetch: permanent, sleep: async () => {} })).rejects.toThrow('401');
    expect(count).toBe(1);
    count = 0;
    const overload = async () => { count++; return new Response(null, { status: 429 }); };
    await expect(sendEventBatch(input, { fetch: overload, sleep: async () => {} })).rejects.toThrow('three bounded attempts');
    expect(count).toBe(3);
  });

  it('rejects prohibited data before any network request', () => {
    expect(() => signEventBatch({ ...input, batch: { ...input.batch, events: [{ ...input.batch.events[0]!, attributes: { authorization: 'never-send' } }] } })).toThrow();
  });
});
