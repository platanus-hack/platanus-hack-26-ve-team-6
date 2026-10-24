import type { Backend } from '@gotchu/backend';
import type { ActionExecutionLedger } from './action-execution.js';

/** The executor database role is checked again by each backend execution operation. */
export function createBackendActionExecutionLedger(executions: Pick<Backend['executions'], 'claim'|'findByApproval'|'listAttempts'|'recordAttempt'|'assertWritable'|'finish'|'resolveUncertain'|'markStale'>): ActionExecutionLedger {
  return {
    claim: input => executions.claim(input),
    findByApproval: input => executions.findByApproval(input),
    listAttempts: input => executions.listAttempts(input),
    recordAttempt: input => executions.recordAttempt(input),
    assertWritable: input => executions.assertWritable(input),
    finish: input => executions.finish(input),
    resolveUncertain: input => executions.resolveUncertain(input),
    markStale: input => executions.markStale(input),
  };
}
