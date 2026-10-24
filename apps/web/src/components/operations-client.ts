import { z } from 'zod';
import {
  customerScopeSchema,
  monitorConfigInputSchema,
  monitorConfigSchema,
  operationAlertSchema,
  operationCoverageSchema,
  operationPlanBindingSchema,
  operationPlanKindSchema,
  operationPlanSchema,
  operationPlanStepSchema,
  operationReadinessSchema,
  telemetryConnectionSchema,
  telemetryIntegrationSchema,
  type OperationPlan,
} from '@gotchu/contracts';
import { customerRequest } from './customer-client';

const repositorySchema = z.object({ key: z.string().max(128), label: z.string().max(200) }).strict();
const repositoryListSchema = z.array(repositorySchema).max(100);
const alertListSchema = z.array(operationAlertSchema).max(100);
const planListSchema = z.array(operationPlanSchema).max(100);
const telemetryListSchema = z.array(telemetryIntegrationSchema).max(20);

type Scope = z.infer<typeof customerScopeSchema>;
type MonitorSettings = Omit<z.input<typeof monitorConfigInputSchema>, 'organizationId' | 'applicationId'>;
type PlanKind = z.infer<typeof operationPlanKindSchema>;
type PlanStepKey = z.infer<typeof operationPlanStepSchema.shape.key>;

function applicationPath({ organizationId, applicationId }: Scope) {
  return `/api/customer/workspaces/${encodeURIComponent(organizationId)}/applications/${encodeURIComponent(applicationId)}`;
}

function bindingPath(scope: Scope, planId: string, action: 'prepare' | 'readiness') {
  return `${applicationPath(scope)}/plans/${encodeURIComponent(planId)}/${action}`;
}

function jsonBody(value: unknown): Pick<RequestInit, 'headers' | 'body'> {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

export const operationsApi = {
  coverage(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/monitoring`, operationCoverageSchema);
  },
  repositories(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/repositories`, repositoryListSchema);
  },
  configure(scope: Scope, settings: MonitorSettings) {
    const input = monitorConfigInputSchema.parse({ ...scope, ...settings });
    return customerRequest(`${applicationPath(scope)}/monitoring`, monitorConfigSchema, {
      method: 'PUT',
      ...jsonBody({
        enabled: input.enabled,
        intervalSeconds: input.intervalSeconds,
        sourceSnapshotId: input.sourceSnapshotId,
        targetId: input.targetId,
        repositoryKey: input.repositoryKey,
        providers: input.providers,
      }),
    });
  },
  alerts(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/alerts`, alertListSchema);
  },
  updateAlert(scope: Scope, alertId: string, input: { state: 'acknowledged' | 'resolved'; resolution?: string }) {
    const body = z.object({ state: z.enum(['acknowledged', 'resolved']), resolution: z.string().min(1).max(2000).optional() }).strict().parse(input);
    return customerRequest(`${applicationPath(scope)}/alerts/${encodeURIComponent(z.uuid().parse(alertId))}`, operationAlertSchema, {
      method: 'PATCH',
      ...jsonBody(body),
    });
  },
  plans(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/plans`, planListSchema);
  },
  createPlan(scope: Scope, input: { kind: PlanKind; observationIds: string[] }) {
    const value = z.object({ kind: operationPlanKindSchema, observationIds: z.array(z.uuid()).min(1).max(20) }).strict().parse(input);
    return customerRequest(`${applicationPath(scope)}/plans`, operationPlanSchema, {
      method: 'POST',
      ...jsonBody(value),
    });
  },
  preparePlan(scope: Scope, plan: OperationPlan) {
    const binding = operationPlanBindingSchema.parse({ ...scope, planId: plan.id, revision: plan.revision, actionHash: plan.actionHash });
    return customerRequest(bindingPath(scope, plan.id, 'prepare'), operationPlanSchema, {
      method: 'POST',
      ...jsonBody({ revision: binding.revision, actionHash: binding.actionHash }),
    });
  },
  attestStep(scope: Scope, plan: OperationPlan, key: PlanStepKey, attestation: string) {
    const value = operationPlanBindingSchema.extend({ key: operationPlanStepSchema.shape.key, attestation: z.string().min(1).max(2000) }).parse({
      ...scope,
      planId: plan.id,
      revision: plan.revision,
      actionHash: plan.actionHash,
      key,
      attestation,
    });
    return customerRequest(`${applicationPath(scope)}/plans/${encodeURIComponent(plan.id)}/steps/${encodeURIComponent(value.key)}`, operationPlanSchema, {
      method: 'POST',
      ...jsonBody({ revision: value.revision, actionHash: value.actionHash, attestation: value.attestation }),
    });
  },
  readiness(scope: Scope, plan: OperationPlan) {
    const binding = operationPlanBindingSchema.parse({ ...scope, planId: plan.id, revision: plan.revision, actionHash: plan.actionHash });
    return customerRequest(bindingPath(scope, plan.id, 'readiness'), operationReadinessSchema, {
      method: 'POST',
      ...jsonBody({ revision: binding.revision, actionHash: binding.actionHash }),
    });
  },
  telemetry(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/telemetry`, telemetryListSchema);
  },
  connectTelemetry(scope: Scope) {
    return customerRequest(`${applicationPath(scope)}/telemetry`, telemetryConnectionSchema, {
      method: 'POST',
      ...jsonBody({}),
    });
  },
  disableTelemetry(scope: Scope, integrationId: string) {
    const id = z.uuid().parse(integrationId);
    return customerRequest(`${applicationPath(scope)}/telemetry/${encodeURIComponent(id)}`, z.undefined(), {
      method: 'DELETE',
    });
  },
};

export type { MonitorSettings, PlanKind, PlanStepKey, Scope as OperationsScope };
