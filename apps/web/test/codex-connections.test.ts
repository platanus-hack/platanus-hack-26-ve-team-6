import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConnections } from '../src/server/codex-connections.js';

const identity = { userId: 'owner' };
const organizationId = randomUUID();
function fixture() {
  let complete: (credential: string | null) => void = () => undefined;
  const credential = new Promise<string | null>(resolve => { complete = resolve; });
  const cancel = vi.fn(async () => { complete(null); });
  const start = vi.fn(async () => ({ verificationUrl: 'https://auth.openai.com/codex/device' as const, userCode: 'ABCD-1234', credential, cancel }));
  const authorizeCodexConnection = vi.fn(async () => 'configuration-v1');
  const connectCodex = vi.fn(async () => undefined);
  const service = createCodexConnections({ authorizeCodexConnection, connectCodex }, start);
  return { service, start, cancel, complete, authorizeCodexConnection, connectCodex };
}
afterEach(() => vi.useRealTimers());

describe('workspace Codex connection ceremonies (injected auth transport)', () => {
  it('binds the ceremony to the initiating user and workspace before importing once', async () => {
    const f = fixture();
    const connection = await f.service.start(identity, organizationId);
    await expect(f.service.get({ userId: 'another-owner' }, organizationId, connection.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.get(identity, randomUUID(), connection.id)).rejects.toMatchObject({ status: 404 });
    f.complete('synthetic-credential'); await Promise.resolve();
    const [first, second] = await Promise.all([f.service.get(identity, organizationId, connection.id), f.service.get(identity, organizationId, connection.id)]);
    expect(first).toEqual({ id: connection.id, status: 'connected' }); expect(second).toEqual(first);
    expect(f.connectCodex).toHaveBeenCalledExactlyOnceWith(identity, { organizationId, version: 'configuration-v1', credential: 'synthetic-credential' });
    expect(JSON.stringify(first)).not.toContain('synthetic-credential');
  });

  it('checks owner authorization before starting and again before importing credentials', async () => {
    const f = fixture();
    f.authorizeCodexConnection.mockRejectedValueOnce(new Error('forbidden'));
    await expect(f.service.start(identity, organizationId)).rejects.toThrow('forbidden');
    expect(f.start).not.toHaveBeenCalled();
    const connection = await f.service.start(identity, organizationId);
    f.complete('synthetic-credential'); await Promise.resolve();
    f.authorizeCodexConnection.mockRejectedValueOnce(new Error('revoked'));
    await expect(f.service.get(identity, organizationId, connection.id)).rejects.toThrow('revoked');
    expect(f.connectCodex).not.toHaveBeenCalled();
  });

  it('cancels without saving even if authorization completed before the next poll', async () => {
    const f = fixture(); const connection = await f.service.start(identity, organizationId);
    f.complete('synthetic-credential'); await Promise.resolve();
    expect(await f.service.get(identity, organizationId, connection.id, true)).toEqual({ id: connection.id, status: 'cancelled' });
    expect(f.connectCodex).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledOnce();
  });

  it('expires and cleans up an abandoned ceremony without a browser poll', async () => {
    vi.useFakeTimers(); const f = fixture(); const connection = await f.service.start(identity, organizationId);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(f.cancel).toHaveBeenCalledOnce();
    await expect(f.service.get(identity, organizationId, connection.id)).rejects.toMatchObject({ status: 404 });
    expect(f.connectCodex).not.toHaveBeenCalled();
  });

  it('cancels the previous attempt when the same owner reconnects', async () => {
    const f = fixture(); const old = await f.service.start(identity, organizationId);
    const next = await f.service.start(identity, organizationId);
    expect(next.id).not.toBe(old.id); expect(f.cancel).toHaveBeenCalledOnce();
    await expect(f.service.get(identity, organizationId, old.id)).rejects.toMatchObject({ status: 404 });
  });
});
