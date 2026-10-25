import { describe, expect, it } from 'vitest';
import { httpRequestEvent } from '../src/index.js';

describe('bounded Node telemetry helpers', () => {
  it('rejects raw query values, malformed metrics and unbounded error text', () => {
    expect(() => httpRequestEvent({ route: '/orders?private=value', statusCode: 200, durationMs: 1 })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 99, durationMs: 1 })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 200, durationMs: NaN })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 200, durationMs: 1, capacityUtilization: 1.01 })).toThrow();
  });
});
