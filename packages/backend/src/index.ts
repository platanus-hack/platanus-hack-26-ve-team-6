import type { Database } from '@gotchu/database';
import type { Clock, CredentialStore } from './core.js';
import { createEventService } from './events.js';
import { createJobService, createOutboxService } from './jobs.js';
import { createWebService } from './web.js';
export * from './core.js';
export * from './events.js';
export * from './jobs.js';
export * from './web.js';
export interface BackendDependencies { database: Database; clock?: Clock; credentials?: CredentialStore }
export function createBackend(deps: BackendDependencies) {
  return { events: createEventService(deps), web: createWebService(deps), outbox: createOutboxService(deps), jobs: createJobService(deps) };
}
export type Backend = ReturnType<typeof createBackend>;
