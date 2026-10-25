import {
  CapabilityError,
  GatewayUnavailableError,
  aiCorrectionInputSchema,
  runBoundedCorrection,
  runBoundedInvestigation,
  verifyRunCapability,
  type InvestigationLimits,
  type InvestigationResult,
  type RunScope,
} from '@gotchu/agent';
import type { CryptoKey } from 'jose';
import { createGatewayHttpAdapters } from './gateway-http.js';

export class WorkerServiceError extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: 'invalid_capability' | 'capability_scope_mismatch' | 'integration_disabled' | 'gateway_unavailable') {
    super(code);
    this.name = 'WorkerServiceError';
  }
}

export interface InvestigationWorkerService {
  readonly ready: boolean;
  readonly readinessReason?: 'gateway_unconfigured';
  investigate(token: string): Promise<InvestigationResult>;
}

export interface CreateWorkerServiceOptions {
  readonly capabilityPublicKey: CryptoKey;
  readonly gatewayBaseUrl?: URL;
  readonly fetchImpl?: typeof fetch;
  readonly limits?: InvestigationLimits;
}

export function createInvestigationWorkerService(options: CreateWorkerServiceOptions): InvestigationWorkerService {
  const gatewayBaseUrl = options.gatewayBaseUrl;

  return {
    ready: gatewayBaseUrl !== undefined,
    ...(gatewayBaseUrl ? {} : { readinessReason: 'gateway_unconfigured' as const }),
    async investigate(token: string): Promise<InvestigationResult> {
      if (!gatewayBaseUrl) throw new WorkerServiceError(503, 'integration_disabled');
      const startedAtMs = performance.now();
      let verified;
      try {
        verified = await verifyRunCapability(token, options.capabilityPublicKey);
      } catch {
        throw new WorkerServiceError(401, 'invalid_capability');
      }
      // Checkpoint versions belong to this invocation. Concurrent deliveries must
      // not adopt each other's versions, and completed runs must leave no cache behind.
      const gateways = createGatewayHttpAdapters(gatewayBaseUrl, options.fetchImpl);
      const scope: RunScope = {
        organizationId: verified.claims.organizationId,
        applicationId: verified.claims.applicationId,
        runId: verified.claims.runId,
      };
      let rawInput: unknown;
      try {
        rawInput = await gateways.inputGateway.loadInput(scope, verified.token);
      } catch (error) {
        if (error instanceof GatewayUnavailableError) throw new WorkerServiceError(503, 'gateway_unavailable');
        if (error instanceof CapabilityError && error.code === 'capability_scope_mismatch') {
          throw new WorkerServiceError(403, 'capability_scope_mismatch');
        }
        if (error instanceof CapabilityError) throw new WorkerServiceError(401, 'invalid_capability');
        throw new WorkerServiceError(503, 'gateway_unavailable');
      }
      const run = aiCorrectionInputSchema.safeParse(rawInput).success ? runBoundedCorrection : runBoundedInvestigation;
      return run(rawInput, {
        capability: verified,
        readTools: gateways.readTools,
        model: gateways.model,
        persistence: gateways.persistence,
        ...(options.limits ? { limits: options.limits } : {}),
        startedAtMs,
      });
    },
  };
}
