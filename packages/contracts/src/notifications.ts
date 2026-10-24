import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => new Date(value).getUTCFullYear() >= 2000);
const severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const notificationUrl = z.url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Webhook destination must be a public HTTPS URL without credentials, query, or fragment');

export const notificationDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), email: z.email().max(254) }).strict(),
  z.object({ kind: z.literal('webhook'), url: notificationUrl }).strict(),
]);

export const notificationChannelSchema = z.object({
  id: uuid,
  kind: z.enum(['email', 'webhook']),
  label: z.string().min(1).max(120),
  state: z.enum(['active', 'disabled']),
  destination: notificationDestinationSchema,
  minimumSeverity: severity,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const createEmailChannelSchema = z.object({
  label: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  minimumSeverity: severity.default('medium'),
}).strict();

export const createWebhookChannelSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: notificationUrl,
  minimumSeverity: severity.default('medium'),
}).strict();

export const notificationEventKindSchema = z.enum([
  'monitoring_stopped', 'monitoring_recovered', 'finding', 'runtime_alert', 'test',
]);
export const notificationDeliverySchema = z.object({
  id: uuid,
  eventId: uuid,
  channelId: uuid,
  channelLabel: z.string().min(1).max(120),
  channelKind: z.enum(['email', 'webhook']),
  eventKind: notificationEventKindSchema,
  severity,
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  state: z.enum(['queued', 'sending', 'sent', 'dead_letter']),
  attempts: z.number().int().min(0).max(8),
  lastError: z.string().max(120).nullable(),
  acceptedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const createWebhookChannelResponseSchema = z.object({
  channel: notificationChannelSchema,
  signingSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const notificationTestQueuedSchema = z.object({ eventId: uuid, queued: z.literal(true) }).strict();

export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;
export type NotificationEventKind = z.infer<typeof notificationEventKindSchema>;
export type CreateEmailChannel = z.infer<typeof createEmailChannelSchema>;
export type CreateWebhookChannel = z.infer<typeof createWebhookChannelSchema>;
