import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createEmailChannelSchema,
  createWebhookChannelSchema,
  notificationChannelSchema,
  notificationDeliverySchema,
  notificationDestinationSchema,
  notificationEventKindSchema,
  notificationTestQueuedSchema,
  type NotificationChannel,
  type NotificationEventKind,
} from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import type { BaseDependencies, Identity } from './core.js';
import { audit, authorize, BackendError, parse } from './core.js';
import { enqueue } from './jobs.js';

export interface NotificationSecretStore {
  get(reference: string): Promise<Uint8Array>;
  put(reference: string, secret: Uint8Array): Promise<void>;
  delete(reference: string): Promise<void>;
}

export interface WebhookAddressValidator { validate(url: string): Promise<void> }

export interface NotificationEventInput {
  organizationId: string;
  applicationId: string;
  eventKey: string;
  eventKind: NotificationEventKind;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  channelId?: string;
}

export interface NotificationDeliveryWork {
  organizationId: string;
  applicationId: string;
  deliveryId: string;
  leaseToken: string;
  eventId: string;
  idempotencyKey: string;
  attempt: number;
  channelKind: 'email' | 'webhook';
  destination: z.infer<typeof notificationDestinationSchema>;
  secretRef: string | null;
  event: {
    kind: NotificationEventKind;
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    title: string;
    message: string;
    createdAt: string;
  };
}

const workspaceScope = z.object({ organizationId: z.uuid() }).strict();
const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
const channelProjection = `jsonb_build_object('id',id,'kind',kind,'label',label,'state',state,'destination',destination,
 'minimumSeverity',minimum_severity,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS body`;
const deliveryWorkSchema = z.object({
  organizationId: z.uuid(), applicationId: z.uuid(), deliveryId: z.uuid(), leaseToken: z.uuid(), eventId: z.uuid(), idempotencyKey: z.string().min(1).max(256),
  attempt: z.number().int().min(1).max(8), channelKind: z.enum(['email', 'webhook']),
  destination: notificationDestinationSchema, secretRef: z.string().min(1).max(256).nullable(),
  event: z.object({ kind: notificationEventKindSchema, severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
    title: z.string().min(1).max(200), message: z.string().min(1).max(1000), createdAt: z.iso.datetime() }).strict(),
}).strict();

/** Must be called in the same transaction as the trusted event that it describes. */
export async function enqueueNotificationEvent(tx: Transaction, raw: NotificationEventInput): Promise<string> {
  const value = z.object({
    organizationId: z.uuid(), applicationId: z.uuid(), eventKey: z.string().min(1).max(256),
    eventKind: notificationEventKindSchema, severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
    title: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(1000), channelId: z.uuid().optional(),
  }).strict().parse(raw);
  value.title=value.title.replace(/[\x00-\x1f\x7f]/g,' ').trim();
  value.message=value.message.replace(/[\x00-\x1f\x7f]/g,' ').trim();
  if(!value.title||!value.message)throw new BackendError('invalid_input','Notification text must contain printable characters');
  const inserted = await tx.query<{ id: string }>(`INSERT INTO gotchu.notification_events(organization_id,id,application_id,event_key,event_kind,severity,title,message)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,event_key) DO NOTHING RETURNING id`,
  [value.organizationId, randomUUID(), value.applicationId, value.eventKey, value.eventKind, value.severity, value.title, value.message]);
  if (!inserted.rowCount) {
    const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.notification_events WHERE organization_id=$1 AND event_key=$2', [value.organizationId, value.eventKey]);
    const eventId = prior.rows[0]?.id;
    if (!eventId) throw new BackendError('notification_event_conflict', 'Notification event disappeared during deduplication', 409);
    return eventId;
  }
  const eventId = inserted.rows[0]?.id;
  if (!eventId) throw new Error('Notification event insert returned no identifier');

  const channels = await tx.query<{ id: string; minimum_severity: keyof typeof severityRank }>(`SELECT id,minimum_severity FROM gotchu.notification_channels
    WHERE organization_id=$1 AND state='active' AND ($2::uuid IS NULL OR id=$2)`, [value.organizationId, value.channelId ?? null]);
  let added = 0;
  for (const channel of channels.rows) {
    if (value.eventKind !== 'test' && severityRank[value.severity] < severityRank[channel.minimum_severity]) continue;
    const created = await tx.query(`INSERT INTO gotchu.notification_deliveries(organization_id,id,event_id,channel_id,idempotency_key,state)
      VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(organization_id,channel_id,idempotency_key) DO NOTHING`,
    [value.organizationId, randomUUID(), eventId, channel.id, `notification:${eventId}`]);
    added += created.rowCount ?? 0;
  }
  if (added > 0) await enqueue(tx, { organizationId: value.organizationId, applicationId: value.applicationId, id: randomUUID(), kind: 'notification',
    idempotencyKey: `notification-event:${eventId}`, payload: { kind: 'alert_delivery', eventId } });
  return eventId;
}

function ensureCoordinator(deps: BaseDependencies) {
  if (deps.database.role !== 'gotchu_coordinator') throw new BackendError('forbidden', 'Only the trusted coordinator may deliver notifications', 403);
}

export function createNotificationService(deps: BaseDependencies & {
  notificationSecrets?: NotificationSecretStore;
  webhookValidator?: WebhookAddressValidator;
}) {
  const authorizeWorkspace = (tx: Transaction, organizationId: string, identity: Identity, write = false) => authorize(tx, organizationId, identity,
    write ? ['owner', 'operator'] : ['owner', 'operator', 'viewer']);

  async function assertChannelCapacity(tx: Transaction, organizationId: string) {
    const result = await tx.query<{ total: number }>('SELECT count(*)::int AS total FROM gotchu.notification_channels WHERE organization_id=$1', [organizationId]);
    if ((result.rows[0]?.total ?? 20) >= 20) throw new BackendError('notification_channel_limit', 'This workspace already has the maximum number of notification channels', 429);
  }

  async function channelById(tx: Transaction, organizationId: string, id: string): Promise<NotificationChannel> {
    const result = await tx.query<{ body: unknown }>(`SELECT ${channelProjection} FROM gotchu.notification_channels WHERE organization_id=$1 AND id=$2`, [organizationId, id]);
    if (!result.rows[0]) throw new BackendError('not_found', 'Notification channel not found', 404);
    return parse(notificationChannelSchema, result.rows[0].body);
  }

  return {
    async listChannels(identity: Identity, input: { organizationId: string }): Promise<NotificationChannel[]> {
      const value = parse(workspaceScope, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorizeWorkspace(tx, value.organizationId, identity);
        const rows = await tx.query<{ body: unknown }>(`SELECT ${channelProjection} FROM gotchu.notification_channels WHERE organization_id=$1 ORDER BY created_at DESC,id`, [value.organizationId]);
        return rows.rows.map(row => parse(notificationChannelSchema, row.body));
      });
    },

    async createEmail(identity: Identity, input: { organizationId: string } & z.input<typeof createEmailChannelSchema>): Promise<NotificationChannel> {
      const { organizationId, ...raw } = input;
      const value = parse(z.object({ organizationId: z.uuid() }).extend(createEmailChannelSchema.shape).strict(), { organizationId, ...raw });
      const id = randomUUID();
      return deps.database.tenant(value.organizationId, async tx => {
        await authorizeWorkspace(tx, value.organizationId, identity, true);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notification-channels:${value.organizationId}`]);
        await assertChannelCapacity(tx, value.organizationId);
        await tx.query(`INSERT INTO gotchu.notification_channels(organization_id,id,kind,label,destination,minimum_severity,state,created_by)
          VALUES($1,$2,'email',$3,$4::jsonb,$5,'active',$6)`, [value.organizationId,id,value.label,JSON.stringify({kind:'email',email:value.email}),value.minimumSeverity,identity.userId]);
        await audit(tx,value.organizationId,identity.userId,'notification.channel_created',id,{kind:'email',minimumSeverity:value.minimumSeverity});
        return channelById(tx, value.organizationId, id);
      });
    },

    async createWebhook(identity: Identity, input: { organizationId: string } & z.input<typeof createWebhookChannelSchema>) {
      const { organizationId, ...raw } = input;
      const value = parse(z.object({ organizationId: z.uuid() }).extend(createWebhookChannelSchema.shape).strict(), { organizationId, ...raw });
      if (!deps.notificationSecrets || !deps.webhookValidator) throw new BackendError('notification_adapters_unavailable', 'Webhook validation and secret storage are not configured', 503);
      await deps.database.tenant(value.organizationId, tx => authorizeWorkspace(tx, value.organizationId, identity, true));
      try { await deps.webhookValidator.validate(value.url); }
      catch (cause) {
        if (cause instanceof BackendError) throw cause;
        throw new BackendError('webhook_destination_unavailable', 'The HTTPS destination could not be validated safely', 503, { cause });
      }
      const id = randomUUID();
      const secretRef = `local-notification:${id}`;
      const secret = randomBytes(32);
      try { await deps.notificationSecrets.put(secretRef, secret); }
      catch (cause) { throw new BackendError('notification_secret_unavailable', 'Webhook secret storage is unavailable', 503, { cause }); }
      try {
        const channel = await deps.database.tenant(value.organizationId, async tx => {
          await authorizeWorkspace(tx, value.organizationId, identity, true);
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notification-channels:${value.organizationId}`]);
          await assertChannelCapacity(tx, value.organizationId);
          await tx.query(`INSERT INTO gotchu.notification_channels(organization_id,id,kind,label,destination,secret_ref,minimum_severity,state,created_by)
            VALUES($1,$2,'webhook',$3,$4::jsonb,$5,$6,'active',$7)`, [value.organizationId,id,value.label,JSON.stringify({kind:'webhook',url:value.url}),secretRef,value.minimumSeverity,identity.userId]);
          await audit(tx,value.organizationId,identity.userId,'notification.channel_created',id,{kind:'webhook',minimumSeverity:value.minimumSeverity});
          return channelById(tx, value.organizationId, id);
        });
        return { channel, signingSecret: secret.toString('base64url') };
      } catch (cause) {
        try { await deps.notificationSecrets.delete(secretRef); }
        catch (cleanup) { throw new BackendError('notification_secret_cleanup_required', 'Channel creation failed and secret cleanup needs operator review', 503, { cause: new AggregateError([cause, cleanup]) }); }
        throw cause;
      }
    },

    async disable(identity: Identity, input: { organizationId: string; channelId: string }): Promise<void> {
      const value = parse(workspaceScope.extend({ channelId: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorizeWorkspace(tx, value.organizationId, identity, true);
        const disabled = await tx.query(`UPDATE gotchu.notification_channels SET state='disabled',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND id=$2 AND state='active'`, [value.organizationId, value.channelId]);
        if (!disabled.rowCount) {
          const exists = await tx.query('SELECT 1 FROM gotchu.notification_channels WHERE organization_id=$1 AND id=$2', [value.organizationId, value.channelId]);
          if (!exists.rowCount) throw new BackendError('not_found', 'Notification channel not found', 404);
        }
        await tx.query(`UPDATE gotchu.notification_deliveries SET state='dead_letter',last_error='channel_disabled',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND channel_id=$2 AND state='queued'`, [value.organizationId, value.channelId]);
        await audit(tx,value.organizationId,identity.userId,'notification.channel_disabled',value.channelId);
      });
    },

    async sendTest(identity: Identity, input: { organizationId: string; channelId: string }) {
      const value = parse(workspaceScope.extend({ channelId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorizeWorkspace(tx, value.organizationId, identity, true);
        const channel = await tx.query<{ kind: string; state: string }>('SELECT kind,state FROM gotchu.notification_channels WHERE organization_id=$1 AND id=$2', [value.organizationId,value.channelId]);
        if (!channel.rows[0]) throw new BackendError('not_found', 'Notification channel not found', 404);
        if (channel.rows[0].state !== 'active') throw new BackendError('notification_channel_disabled', 'Enable this channel before sending a test', 409);
        const app = await tx.query<{ id: string }>('SELECT id FROM gotchu.applications WHERE organization_id=$1 ORDER BY created_at,id LIMIT 1', [value.organizationId]);
        if (!app.rows[0]) throw new BackendError('application_required', 'Add an application before sending a notification test', 409);
        const eventId = await enqueueNotificationEvent(tx, { organizationId: value.organizationId, applicationId: app.rows[0].id,
          eventKey: `test:${value.channelId}:${randomUUID()}`, eventKind: 'test', severity: 'info', title: 'Prueba de notificación',
          message: `Gotchu pudo poner un mensaje de prueba en cola para el canal ${channel.rows[0].kind}.`, channelId: value.channelId });
        await audit(tx,value.organizationId,identity.userId,'notification.test_queued',value.channelId,{eventId});
        return notificationTestQueuedSchema.parse({ eventId, queued: true });
      });
    },

    async listDeliveries(identity: Identity, input: { organizationId: string; limit?: number }) {
      const value = parse(workspaceScope.extend({ limit: z.number().int().min(1).max(100).default(50) }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorizeWorkspace(tx, value.organizationId, identity);
        const rows = await tx.query<{ id:string;event_id:string;channel_id:string;channel_label:string;channel_kind:string;event_kind:string;severity:string;title:string;message:string;state:string;attempts:number;last_error:string|null;provider_accepted_at:Date|null;created_at:Date;updated_at:Date }>(`SELECT d.id,d.event_id,d.channel_id,c.label AS channel_label,c.kind AS channel_kind,
          e.event_kind,e.severity,e.title,e.message,d.state,d.attempts,d.last_error,d.provider_accepted_at,d.created_at,d.updated_at
          FROM gotchu.notification_deliveries d JOIN gotchu.notification_channels c ON c.organization_id=d.organization_id AND c.id=d.channel_id
          JOIN gotchu.notification_events e ON e.organization_id=d.organization_id AND e.id=d.event_id WHERE d.organization_id=$1
          ORDER BY d.updated_at DESC,d.id LIMIT $2`, [value.organizationId,value.limit]);
        return rows.rows.map(row => parse(notificationDeliverySchema, { id:row.id,eventId:row.event_id,channelId:row.channel_id,channelLabel:row.channel_label,
          channelKind:row.channel_kind,eventKind:row.event_kind,severity:row.severity,title:row.title,message:row.message,state:row.state,attempts:row.attempts,
          lastError:row.last_error,acceptedAt:row.provider_accepted_at?.toISOString() ?? null,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString() }));
      });
    },

    async claimEventDeliveries(input: { organizationId: string; eventId: string; limit?: number; leaseMs?: number }): Promise<NotificationDeliveryWork[]> {
      ensureCoordinator(deps);
      const value = parse(z.object({ organizationId:z.uuid(),eventId:z.uuid(),limit:z.number().int().min(1).max(4).default(4),leaseMs:z.number().int().min(5_000).max(60_000).default(30_000) }).strict(),input);
      return deps.database.tenant(value.organizationId, async tx => {
        await tx.query(`UPDATE gotchu.notification_deliveries d SET state='dead_letter',last_error='channel_disabled',updated_at=clock_timestamp()
          FROM gotchu.notification_channels c WHERE d.organization_id=$1 AND d.event_id=$2 AND d.channel_id=c.id
          AND c.organization_id=d.organization_id AND c.state='disabled' AND d.state='queued'`,[value.organizationId,value.eventId]);
        const rows = await tx.query<{ organization_id:string;application_id:string;delivery_id:string;lease_token:string;event_id:string;idempotency_key:string;attempts:number;channel_kind:string;destination:unknown;secret_ref:string|null;event_kind:string;severity:string;title:string;message:string;created_at:Date }>(`WITH due AS (
          SELECT d.organization_id,d.id FROM gotchu.notification_deliveries d JOIN gotchu.notification_channels c ON c.organization_id=d.organization_id AND c.id=d.channel_id
          WHERE d.organization_id=$1 AND d.event_id=$2 AND c.state='active'
            AND ((d.state='queued' AND d.next_attempt_at<=clock_timestamp()) OR (d.state='sending' AND d.lease_until<=clock_timestamp()))
          ORDER BY d.next_attempt_at,d.id LIMIT $3 FOR UPDATE OF d SKIP LOCKED
        ) UPDATE gotchu.notification_deliveries d SET state='sending',attempts=d.attempts+1,lease_token=gen_random_uuid(),
          lease_until=clock_timestamp()+$4*interval '1 millisecond',updated_at=clock_timestamp()
          FROM due,gotchu.notification_channels c,gotchu.notification_events e
          WHERE d.organization_id=due.organization_id AND d.id=due.id AND c.organization_id=d.organization_id AND c.id=d.channel_id
            AND e.organization_id=d.organization_id AND e.id=d.event_id
          RETURNING d.organization_id,e.application_id,d.id AS delivery_id,d.lease_token,d.event_id,d.idempotency_key,d.attempts,c.kind AS channel_kind,c.destination,c.secret_ref,
            e.event_kind,e.severity,e.title,e.message,e.created_at`,[value.organizationId,value.eventId,value.limit,value.leaseMs]);
        return rows.rows.map(row => deliveryWorkSchema.parse({ organizationId:row.organization_id,applicationId:row.application_id,deliveryId:row.delivery_id,leaseToken:row.lease_token,eventId:row.event_id,
          idempotencyKey:row.idempotency_key,attempt:row.attempts,channelKind:row.channel_kind,destination:row.destination,secretRef:row.secret_ref,
          event:{kind:row.event_kind,severity:row.severity,title:row.title,message:row.message,createdAt:row.created_at.toISOString()} }));
      });
    },

    async settleDelivery(input: { organizationId:string; deliveryId:string; leaseToken:string; outcome:'accepted'|'retryable'|'permanent'; reason?:string }) {
      ensureCoordinator(deps);
      const value = parse(z.object({ organizationId:z.uuid(),deliveryId:z.uuid(),leaseToken:z.uuid(),outcome:z.enum(['accepted','retryable','permanent']),reason:z.string().regex(/^[a-z0-9_]{1,120}$/).optional() }).strict(),input);
      return deps.database.tenant(value.organizationId,async tx=>{
        const row=await tx.query<{attempts:number}>(`SELECT attempts FROM gotchu.notification_deliveries WHERE organization_id=$1 AND id=$2
          AND state='sending' AND lease_token=$3 AND lease_until>clock_timestamp() FOR UPDATE`,[value.organizationId,value.deliveryId,value.leaseToken]);
        const attempts=row.rows[0]?.attempts;
        if(attempts===undefined)throw new BackendError('stale_lease','Notification delivery lease is no longer current',409);
        if(value.outcome==='accepted'){
          await tx.query(`UPDATE gotchu.notification_deliveries SET state='sent',lease_token=NULL,lease_until=NULL,last_error=NULL,
            provider_accepted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2`,[value.organizationId,value.deliveryId]);
          return {state:'sent' as const,nextAttemptAt:null};
        }
        const retry=value.outcome==='retryable'&&attempts<5;
        const waitMs=Math.min(8000,500*2**Math.max(0,attempts-1));
        const state=retry?'queued' as const:'dead_letter' as const;
        const result=await tx.query<{next_attempt_at:Date|null}>(`UPDATE gotchu.notification_deliveries SET state=$4,lease_token=NULL,lease_until=NULL,
          last_error=$5,next_attempt_at=CASE WHEN $4='queued' THEN clock_timestamp()+$6*interval '1 millisecond' ELSE next_attempt_at END,
          updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3 RETURNING next_attempt_at`,
        [value.organizationId,value.deliveryId,value.leaseToken,state,value.reason??'provider_rejected',waitMs]);
        return {state,nextAttemptAt:retry?result.rows[0]?.next_attempt_at?.toISOString()??null:null};
      });
    },

    async nextEventAttempt(input:{organizationId:string;eventId:string}) {
      ensureCoordinator(deps);
      const value=parse(z.object({organizationId:z.uuid(),eventId:z.uuid()}).strict(),input);
      return deps.database.tenant(value.organizationId,async tx=>{
        const result=await tx.query<{next_attempt_at:Date|null;pending:boolean}>(`SELECT min(CASE WHEN state='sending' THEN lease_until ELSE next_attempt_at END)
          FILTER(WHERE state IN ('queued','sending')) AS next_attempt_at,
          count(*) FILTER(WHERE state IN ('queued','sending'))>0 AS pending
          FROM gotchu.notification_deliveries WHERE organization_id=$1 AND event_id=$2`,[value.organizationId,value.eventId]);
        return {pending:result.rows[0]?.pending===true,nextAttemptAt:result.rows[0]?.next_attempt_at?.toISOString()??null};
      });
    },
  };
}
