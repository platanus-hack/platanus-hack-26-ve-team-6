import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createValidationInputRegistry } from '../src/input-registry.js';

describe('validation VM input registry', () => {
  it('uses the same scoped resolver for staged jobs and removes only each settled invocation', async () => {
    const registry = createValidationInputRegistry();
    const first = Buffer.from('first archive');
    const concurrent = Buffer.from('concurrent archive');
    const firstRef = { objectId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: first.length };
    const concurrentRef = { objectId: randomUUID(), sha256: 'b'.repeat(64), sizeBytes: concurrent.length };
    const scope = { organizationId: randomUUID(), jobId: randomUUID() };
    let finishFirst: (() => void) | undefined;
    let markFirstReady: (() => void) | undefined;
    let firstResolved: Uint8Array | undefined;
    const firstReady = new Promise<void>(resolve => { markFirstReady = resolve; });
    const releaseFirst = new Promise<void>(resolve => { finishFirst = resolve; });
    const firstRun = registry.withInput(scope.organizationId, firstRef.objectId, first, async () => {
      firstResolved = await registry.resolveInput(firstRef, scope);
      markFirstReady?.();
      await releaseFirst;
    });
    await firstReady;
    await registry.withInput(scope.organizationId, concurrentRef.objectId, concurrent, async () => {
      expect(await registry.resolveInput(concurrentRef, scope)).toBe(concurrent);
    });
    expect(firstResolved).toBe(first);
    expect(await registry.resolveInput(firstRef, scope)).toBe(first);
    await expect(registry.resolveInput(concurrentRef, scope)).rejects.toThrow('validation_input_expired');
    await expect(registry.resolveInput(concurrentRef, { ...scope, organizationId: randomUUID() })).rejects.toThrow('validation_input_expired');
    finishFirst?.();
    await firstRun;
    await expect(registry.resolveInput(firstRef, scope)).rejects.toThrow('validation_input_expired');
  });
});
