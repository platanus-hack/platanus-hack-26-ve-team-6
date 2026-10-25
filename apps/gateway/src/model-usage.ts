import { safeCheckpointSchema, type RunScope } from '@gotchu/agent';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { GatewayError } from './errors.js';

/** Commit immediately after provider completion, before overrun guards or settlement.
 * Observations survive rejected settlement; they never charge usage or release holds.
 */
export async function recordObservedModelUsage(
  tx: Transaction, scope: RunScope, reservationId: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  safeCheckpointSchema.shape.scope.parse(scope);
  z.uuid().parse(reservationId);
  const { inputTokens, outputTokens } = usage;
  if (![inputTokens, outputTokens].every(tokens => Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 1_000_000_000)) {
    throw new GatewayError('invalid_model_usage', 502);
  }
  const values = [scope.organizationId, scope.applicationId, scope.runId, reservationId, inputTokens, outputTokens];
  // The conditional update serializes concurrent observations without locking run/budget rows.
  const recorded = await tx.query(`UPDATE gotchu.model_reservations m
    SET observed_input_tokens=$5,observed_output_tokens=$6,observed_at=clock_timestamp()
    FROM gotchu.agent_runs r
    WHERE m.organization_id=$1 AND m.run_id=$3 AND m.id=$4
      AND r.organization_id=m.organization_id AND r.id=m.run_id AND r.application_id=$2
      AND m.state IN ('reserved','in_flight','unknown')
      AND m.charged_micros IS NULL AND m.charged_tokens IS NULL AND m.settled_at IS NULL
      AND (m.input_tokens IS NULL OR m.input_tokens=$5)
      AND (m.output_tokens IS NULL OR m.output_tokens=$6)
      AND m.observed_input_tokens IS NULL AND m.observed_output_tokens IS NULL AND m.observed_at IS NULL
    RETURNING m.id`, values);
  if (recorded.rowCount === 1) return;

  // Exact replay is harmless, including after settlement. Never fill observations on settled rows.
  const same = await tx.query(`SELECT 1 FROM gotchu.model_reservations m
    JOIN gotchu.agent_runs r ON r.organization_id=m.organization_id AND r.id=m.run_id
    WHERE m.organization_id=$1 AND r.application_id=$2 AND m.run_id=$3 AND m.id=$4
      AND m.observed_input_tokens=$5 AND m.observed_output_tokens=$6 AND m.observed_at IS NOT NULL
      AND (
        (m.state IN ('reserved','in_flight','unknown')
          AND m.charged_micros IS NULL AND m.charged_tokens IS NULL AND m.settled_at IS NULL
          AND (m.input_tokens IS NULL OR m.input_tokens=$5)
          AND (m.output_tokens IS NULL OR m.output_tokens=$6))
        OR (m.state='settled' AND m.input_tokens=$5 AND m.output_tokens=$6
          AND m.charged_tokens=$5::bigint+$6::bigint AND m.charged_micros IS NOT NULL AND m.settled_at IS NOT NULL)
      )`, values);
  if (same.rowCount !== 1) throw new GatewayError('model_usage_reservation_conflict', 409);
}
