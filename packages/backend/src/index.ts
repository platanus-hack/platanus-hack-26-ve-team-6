import type { Database } from '@gotchu/database';
import type { Clock, CredentialStore } from './core.js';
import { createEventService } from './events.js';
import { createJobService, createOutboxService } from './jobs.js';
import { createWebService } from './web.js';
import { createProposalService, type StepUpVerifier, type ProposalVerifier } from './proposals.js';
import { createExecutionService } from './executions.js';
import { createRunService } from './runs.js';
import { createCorrectionService } from './corrections.js';
import { createCustomerService, type CustomerDnsVerifier } from './customers.js';
import { createOperationsService } from './operations.js';
import { createAssessmentService } from './assessments.js';
import { createWebAuthnStepUpService } from './step-up.js';
import { createTelemetryService, type WritableEventCredentials } from './telemetry.js';
import { createContextService } from './context.js';
export * from './core.js';
export * from './events.js';
export * from './jobs.js';
export * from './web.js';
export * from './proposals.js';
export * from './executions.js';
export * from './runs.js';
export * from './assessments.js';
export * from './demo.js';
export * from './customers.js';
export * from './corrections.js';
export * from './telemetry.js';
export * from './context.js';
export * from './operations.js';
export * from './step-up.js';
export interface BackendDependencies { database: Database; clock?: Clock; credentials?: CredentialStore; eventCredentials?: WritableEventCredentials; stepUpVerifier?: StepUpVerifier; proposalVerifier?: ProposalVerifier; customerDnsVerifier?: CustomerDnsVerifier; webAuthn?: { rpID: string; origin: string; rpName?: string; verifyPassword?: (userId: string, password: string) => Promise<boolean | null> } }
export function createBackend(deps: BackendDependencies) {
  const stepUp = deps.webAuthn ? createWebAuthnStepUpService({ ...deps, webAuthn: deps.webAuthn }) : null;
  return { corrections: createCorrectionService(deps), operations: createOperationsService(deps), events: createEventService(deps), web: createWebService(deps), outbox: createOutboxService(deps), jobs: createJobService(deps), proposals: createProposalService({ ...deps, ...(stepUp ? { stepUpVerifier: stepUp.verifier } : {}) }), executions: createExecutionService(deps), runs: createRunService(deps), assessments: createAssessmentService(deps), customers: createCustomerService(deps), telemetry: createTelemetryService(deps), context: createContextService(deps), stepUp };
}
export type Backend = ReturnType<typeof createBackend>;
