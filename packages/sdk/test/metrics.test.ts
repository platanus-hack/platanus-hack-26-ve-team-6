import { describe, expect, it } from 'vitest';
import { httpRequestEvent, applicationErrorEvent } from '../src/index.js';

describe('bounded Node telemetry helpers', () => {
  it('emits bounded request metrics and categorical application errors', () => {
    const event = httpRequestEvent({ route: '/orders/:id', statusCode: 503, durationMs: 1500, capacityUtilization: 0.92 });
    expect(event).toMatchObject({ type: 'http.request', source: 'application', outcome: 'failure', resource: { type: 'route', id: '/orders/:id' }, attributes: { statusCode: 503, durationMs: 1500, capacityUtilization: 0.92 } });
    expect(applicationErrorEvent('database')).toMatchObject({ type: 'app.error', attributes: { category: 'database' } });
  });
  it('rejects raw query values, malformed metrics and unbounded error text', () => {
    expect(() => httpRequestEvent({ route: '/orders?private=value', statusCode: 200, durationMs: 1 })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 99, durationMs: 1 })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 200, durationMs: NaN })).toThrow();
    expect(() => httpRequestEvent({ route: '/', statusCode: 200, durationMs: 1, capacityUtilization: 1.01 })).toThrow();
  });
});
