import { setTimeout as delay } from 'node:timers/promises';
import type { Backend, NotificationDeliveryWork } from '@gotchu/backend';

export type NotificationSendResult =
  | { outcome: 'accepted' }
  | { outcome: 'retryable' | 'permanent'; reason: string };

export interface NotificationDeliverySender {
  send(work: NotificationDeliveryWork, signal: AbortSignal): Promise<NotificationSendResult>;
}

/** Processes durable Postgres delivery rows outside the HTTP request and completes the Redis-woken job afterward. */
export function createNotificationDeliveryWorker(options: { backend: Backend; sender: NotificationDeliverySender; maxRunMs?: number }) {
  const maxRunMs = options.maxRunMs ?? 240_000;
  if (!Number.isInteger(maxRunMs) || maxRunMs < 1_000 || maxRunMs > 270_000) throw new Error('invalid_notification_worker_deadline');

  return {
    async deliverEvent(input: { organizationId: string; eventId: string }) {
      const deadline = AbortSignal.timeout(maxRunMs);
      while (true) {
        deadline.throwIfAborted();
        const batch = await options.backend.notifications.claimEventDeliveries({ ...input, limit: 4 });
        if (batch.length > 0) {
          const settled = await Promise.allSettled(batch.map(work => deliverOne(work, options.sender, options.backend, deadline)));
          const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failure) throw failure.reason;
          continue;
        }

        const pending = await options.backend.notifications.nextEventAttempt(input);
        if (!pending.pending) return;
        const nextAt = pending.nextAttemptAt ? Date.parse(pending.nextAttemptAt) : Date.now() + 250;
        await delay(Math.min(2_000, Math.max(100, nextAt - Date.now())), undefined, { signal: deadline });
      }
    },
  };
}

async function deliverOne(work: NotificationDeliveryWork, sender: NotificationDeliverySender, backend: Backend, signal: AbortSignal) {
  let result: NotificationSendResult;
  try { result = await sender.send(work, signal); }
  catch { result = { outcome: 'retryable', reason: 'provider_unavailable' }; }
  await backend.notifications.settleDelivery({ organizationId:work.organizationId,deliveryId:work.deliveryId,leaseToken:work.leaseToken,
    outcome:result.outcome==='accepted'?'accepted':result.outcome, ...(result.outcome==='accepted'?{}:{reason:result.reason}) });
}
