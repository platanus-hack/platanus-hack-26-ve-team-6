import { createHash } from 'node:crypto';
import { z } from 'zod';

export const authFailureEventSchema = z.object({
  eventId: z.uuid(),
  organizationId: z.uuid(),
  applicationId: z.uuid(),
  occurredAt: z.iso.datetime(),
  type: z.enum(['auth.login_failed', 'auth.login_succeeded']),
  outcome: z.enum(['failure', 'success', 'blocked', 'unknown']),
  actor: z.object({
    accountId: z.string().min(1).max(128).optional(),
    ip: z.union([z.ipv4(), z.ipv6()]).optional(),
  }).strict().optional(),
}).strict();

export type AuthFailureEvent = z.input<typeof authFailureEventSchema>;

export const authFailureIncidentSchema = z.object({
  incidentId: z.string().regex(/^authfail_[a-f0-9]{24}$/),
  organizationId: z.uuid(),
  applicationId: z.uuid(),
  grouping: z.enum(['actor_account', 'ip']),
  groupKey: z.string().min(1).max(256),
  windowStartAt: z.iso.datetime(),
  firstOccurredAt: z.iso.datetime(),
  lastOccurredAt: z.iso.datetime(),
  failedAttempts: z.number().int().min(5),
  eventIds: z.array(z.uuid()).min(5),
  classification: z.literal('suspicious_auth_activity'),
  confirmedCompromise: z.literal(false),
}).strict();
export type AuthFailureIncident = z.infer<typeof authFailureIncidentSchema>;

export interface AuthFailureAggregation {
  readonly incidents: readonly AuthFailureIncident[];
  readonly blockedAttempts: number;
  readonly deduplicatedEvents: number;
  readonly confirmedCompromise: false;
}

const WINDOW_MS = 10 * 60 * 1000;
const THRESHOLD = 5;

/** Fixed UTC ten-minute buckets; account IDs remain opaque and account/IP groups stay separate. */
export function aggregateAuthFailures(events: readonly AuthFailureEvent[]): AuthFailureAggregation {
  const parsed = events.map((event) => authFailureEventSchema.parse(event));
  const unique = new Map<string, z.infer<typeof authFailureEventSchema>>();
  for (const event of parsed) {
    if (!unique.has(event.eventId)) unique.set(event.eventId, event);
  }

  let blockedAttempts = 0;
  const groupEvents = new Map<string, {
    organizationId: string;
    applicationId: string;
    grouping: 'actor_account' | 'ip';
    groupKey: string;
    windowStartAt: string;
    events: Array<{ id: string; at: number }>;
  }>();

  for (const event of unique.values()) {
    if (event.type === 'auth.login_failed' && event.outcome === 'blocked') blockedAttempts += 1;
    if (event.type !== 'auth.login_failed' || event.outcome !== 'failure') continue;
    const keys: Array<{ grouping: 'actor_account' | 'ip'; value: string }> = [];
    // accountId is opaque. Preserve its exact bytes unless an integration-specific policy says otherwise.
    if (event.actor?.accountId) keys.push({ grouping: 'actor_account', value: event.actor.accountId });
    if (event.actor?.ip) keys.push({ grouping: 'ip', value: event.actor.ip.toLowerCase() });
    for (const item of keys) {
      const at = Date.parse(event.occurredAt);
      const windowStart = Math.floor(at / WINDOW_MS) * WINDOW_MS;
      const windowStartAt = new Date(windowStart).toISOString();
      const composite = `${event.organizationId}:${event.applicationId}:${item.grouping}:${item.value}:${windowStart}`;
      let group = groupEvents.get(composite);
      if (!group) {
        group = {
          organizationId: event.organizationId,
          applicationId: event.applicationId,
          grouping: item.grouping,
          groupKey: item.value,
          windowStartAt,
          events: [],
        };
        groupEvents.set(composite, group);
      }
      group.events.push({ id: event.eventId, at });
    }
  }

  const incidents: AuthFailureIncident[] = [];
  for (const group of groupEvents.values()) {
    const sorted = group.events.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    if (sorted.length < THRESHOLD) continue;
    const eventIds = sorted.map((event) => event.id);
    // Identity depends on the detector, group, and fixed time bucket, not the growing event sample.
    const digest = createHash('sha256')
      .update(`${group.organizationId}\0${group.applicationId}\0auth.login_failed\0${group.grouping}\0${group.groupKey}\0${group.windowStartAt}`)
      .digest('hex').slice(0, 24);
    const firstEvent = sorted.at(0);
    const lastEvent = sorted.at(-1);
    if (!firstEvent || !lastEvent) continue;
    incidents.push(authFailureIncidentSchema.parse({
      incidentId: `authfail_${digest}`,
      organizationId: group.organizationId,
      applicationId: group.applicationId,
      grouping: group.grouping,
      groupKey: group.groupKey,
      windowStartAt: group.windowStartAt,
      firstOccurredAt: new Date(firstEvent.at).toISOString(),
      lastOccurredAt: new Date(lastEvent.at).toISOString(),
      failedAttempts: sorted.length,
      eventIds,
      classification: 'suspicious_auth_activity',
      confirmedCompromise: false,
    }));
  }

  incidents.sort((left, right) => left.incidentId.localeCompare(right.incidentId));
  return {
    incidents,
    blockedAttempts,
    deduplicatedEvents: events.length - unique.size,
    confirmedCompromise: false,
  };
}
