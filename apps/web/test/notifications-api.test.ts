import { describe, expect, it, vi } from 'vitest';
import { notificationChannelSchema, notificationTestQueuedSchema } from '@gotchu/contracts';
import type { Backend } from '@gotchu/backend';
import { handleNotificationsApi } from '../src/server/notifications-api.js';

const origin = 'https://gotchu.test';
const organizationId = '10000000-0000-4000-8000-000000000001';
const channel = notificationChannelSchema.parse({
  id: '30000000-0000-4000-8000-000000000003', kind: 'email', label: 'Security team', state: 'active',
  destination: { kind: 'email', email: 'alerts@example.com' }, minimumSeverity: 'high',
  createdAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:00:00.000Z',
});
const identity = { userId: 'owner' };
const noop = async () => undefined;

function apiService(): Backend['notifications'] {
  return {
    listChannels: vi.fn(async () => [channel]),
    createEmail: vi.fn(async () => channel),
    createWebhook: vi.fn(async () => ({ channel, signingSecret: 'A'.repeat(43) })),
    disable: vi.fn(noop),
    sendTest: vi.fn(async () => notificationTestQueuedSchema.parse({ eventId: '40000000-0000-4000-8000-000000000004', queued: true })),
    listDeliveries: vi.fn(async () => []),
    claimEventDeliveries: vi.fn(async () => []),
    settleDelivery: vi.fn(async () => ({ state: 'sent' as const, nextAttemptAt: null })),
    nextEventAttempt: vi.fn(async () => ({ pending: false, nextAttemptAt: null })),
  };
}

function request(path: string, method = 'GET', payload?: unknown) {
  return new Request(`${origin}${path}`, payload === undefined ? { method } : {
    method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

describe('workspace notification HTTP routes', () => {
  it('keeps the authenticated path tenant and strict channel input at the API boundary', async () => {
    const service = apiService();
    const list = await handleNotificationsApi(request(`/api/customer/workspaces/${organizationId}/notifications`), identity, service, origin);
    expect(list?.status).toBe(200);
    expect(await list?.json()).toEqual([channel]);
    expect(service.listChannels).toHaveBeenCalledExactlyOnceWith(identity, { organizationId });

    const extra = await handleNotificationsApi(request(`/api/customer/workspaces/${organizationId}/notifications/channels`, 'POST', {
      kind: 'email', label: 'Team', email: 'alerts@example.com', minimumSeverity: 'high', organizationId,
    }), identity, service, origin);
    expect(extra?.status).toBe(400);
    expect(service.createEmail).not.toHaveBeenCalled();
  });

  it('returns the webhook secret on creation and queues a test without delivering in the request', async () => {
    const service = apiService();
    const created = await handleNotificationsApi(request(`/api/customer/workspaces/${organizationId}/notifications/channels`, 'POST', {
      kind: 'webhook', label: 'Pager', url: 'https://alerts.example.com/gotchu', minimumSeverity: 'critical',
    }), identity, service, origin);
    expect(created?.status).toBe(201);
    expect(await created?.json()).toMatchObject({ signingSecret: 'A'.repeat(43), channel: { id: channel.id } });
    expect(service.createWebhook).toHaveBeenCalledExactlyOnceWith(identity, {
      organizationId, label: 'Pager', url: 'https://alerts.example.com/gotchu', minimumSeverity: 'critical',
    });

    const tested = await handleNotificationsApi(request(`/api/customer/workspaces/${organizationId}/notifications/channels/${channel.id}/test`, 'POST', {}), identity, service, origin);
    expect(tested?.status).toBe(202);
    expect(await tested?.json()).toEqual({ eventId: '40000000-0000-4000-8000-000000000004', queued: true });
    expect(service.sendTest).toHaveBeenCalledExactlyOnceWith(identity, { organizationId, channelId: channel.id });
  });

  it('refuses webhook URLs outside HTTPS and cross origin before backend writes', async () => {
    const service = apiService();
    const invalid = await handleNotificationsApi(request(`/api/customer/workspaces/${organizationId}/notifications/channels`, 'POST', {
      kind: 'webhook', label: 'Unsafe', url: 'http://127.0.0.1/hook',
    }), identity, service, origin);
    expect(invalid?.status).toBe(400);
    expect(service.createWebhook).not.toHaveBeenCalled();

    const crossOrigin = await handleNotificationsApi(new Request(`https://attacker.test/api/customer/workspaces/${organizationId}/notifications/channels`, {
      method: 'POST', headers: { origin: 'https://attacker.test', 'content-type': 'application/json' }, body: '{}',
    }), identity, service, origin);
    expect(crossOrigin?.status).toBe(400);
    expect(service.createEmail).not.toHaveBeenCalled();
  });
});
