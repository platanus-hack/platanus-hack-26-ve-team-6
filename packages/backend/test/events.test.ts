import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, signEventBody, verifyEventSignature } from '../src/index.js';
const secret = new Uint8Array(32).fill(42);
const now = new Date('2026-10-24T04:00:00Z');
const integrationId = randomUUID();
const timestamp = String(now.getTime() / 1000);
const rawBody = Buffer.from('{ "exact": true }');
const valid = { integrationId, timestamp, rawBody, signature: signEventBody(secret, integrationId, timestamp, rawBody) };
describe('signed raw event envelopes', () => {
  it('accepts the authentic exact bytes and rejects changed whitespace and integration context', () => {
    expect(() => verifyEventSignature(valid, secret, now)).not.toThrow();
    expect(() => verifyEventSignature({ ...valid, rawBody: Buffer.from('{"exact":true}') }, secret, now)).toThrow('authentication');
    expect(() => verifyEventSignature({ ...valid, integrationId: randomUUID() }, secret, now)).toThrow('authentication');
  });
  it('rejects stale/future timestamps and malformed or forged signatures without length exceptions', () => {
    for (const delta of [-301_000, 301_000]) expect(() => verifyEventSignature(valid, secret, new Date(now.getTime() + delta))).toThrow('authentication');
    for (const signature of ['', 'a', 'f'.repeat(64), 'A'.repeat(64), 'f'.repeat(66), 'z'.repeat(64)]) expect(() => verifyEventSignature({ ...valid, signature }, secret, now)).toThrow('authentication');
  });
  it('bounds the body before crypto and rejects undersized credentials', () => {
    expect(() => verifyEventSignature({ ...valid, rawBody: Buffer.alloc(256 * 1024 + 1) }, secret, now)).toThrow('limit');
    expect(() => verifyEventSignature(valid, secret.slice(0, 16), now)).toThrow('unavailable');
  });
  it('canonicalizes object keys but retains ordered arrays and rejects non-JSON values', () => {
    expect(canonicalJson({ z: 1, a: { x: true, b: null } })).toBe(canonicalJson({ a: { b: null, x: true }, z: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    for (const value of [NaN, Infinity, undefined, new Date(), { x: undefined }]) expect(() => canonicalJson(value)).toThrow();
  });
});
