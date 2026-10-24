import type { Database } from '@gotchu/database';
import type { Clock, CredentialStore } from './core.js';
import { createEventService } from './events.js';
import { createJobService, createOutboxService } from './jobs.js';
import { createWebService } from './web.js';
import { createProposalService, type StepUpVerifier, type ProposalVerifier } from './proposals.js';
import { createExecutionService } from './executions.js';
import { createRunService } from './runs.js';
export * from './core.js';
export * from './events.js';
export * from './jobs.js';
export * from './web.js';
export * from './proposals.js';
export * from './executions.js';
export * from './runs.js';
export interface BackendDependencies { database: Database; clock?: Clock; credentials?: CredentialStore; stepUpVerifier?: StepUpVerifier; proposalVerifier?: ProposalVerifier }
export function createBackend(deps: BackendDependencies) {
  return { events: createEventService(deps), web: createWebService(deps), outbox: createOutboxService(deps), jobs: createJobService(deps), proposals: createProposalService(deps), executions: createExecutionService(deps), runs: createRunService(deps) };
}
export type Backend = ReturnType<typeof createBackend>;
