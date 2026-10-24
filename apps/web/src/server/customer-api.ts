import { z } from 'zod';
import {
  customerCreateWorkspaceSchema, customerCreateApplicationSchema, customerUpdateApplicationSchema,
  customerEnrollTargetSchema, customerTargetIdSchema, customerUploadSourceSchema, customerQueueSchema,
  customerWorkspaceSchema, customerApplicationSchema, customerTargetSchema, customerEnrollmentSchema,
  customerSourceSummarySchema, customerReportSummarySchema, customerAssessmentReportSchema, CUSTOMER_MAX_SOURCE_BYTES,
  type CustomerWorkspace, type CustomerApplication, type CustomerTarget, type CustomerEnrollment,
  type CustomerSourceSummary, type CustomerReportSummary, type CustomerAssessmentReport,
  telemetryIntegrationSchema, telemetryConnectionSchema,
  monitorConfigInputSchema, monitorConfigSchema, operationCoverageSchema, operationAlertSchema,
  operationPlanSchema, operationPlanKindSchema, operationPlanBindingSchema, operationPlanStepSchema, operationReadinessSchema,
} from '@gotchu/contracts';
import { type Identity, type Backend } from '@gotchu/backend';
import { prepareCorrectionRequestSchema, prepareCorrectionResponseSchema, reportRecommendationsResponseSchema, type PrepareCorrectionRequest, type PrepareCorrectionResponse, type ReportRecommendationsResponse } from '@gotchu/scenarios/contracts';
import type { AuthService } from './auth.js';
import { localRegistrationSchema, type LocalAccounts } from './local-accounts.js';
import { handleStepUpApi } from './step-up-api.js';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import { handleContextApi } from './context-api.js';

export interface CustomerServices {
  stepUp?: NonNullable<Backend['stepUp']>;
  corrections?: {
    recommendations(identity: Identity, input: { organizationId: string; applicationId: string; reportId: string }): Promise<ReportRecommendationsResponse>;
    prepare(identity: Identity, input: PrepareCorrectionRequest & { organizationId: string; applicationId: string; reportId: string }): Promise<PrepareCorrectionResponse>;
  };
  telemetry?: Backend['telemetry'];
  context?: Backend['context'];
  operations?: Backend['operations'];
  repositoryCatalog?: (identity: Identity, scope: { organizationId: string; applicationId: string }) => Promise<Array<{ key: string; label: string }>>;
  listWorkspaces(identity: Identity): Promise<CustomerWorkspace[]>;
  createWorkspace(identity: Identity, value: z.infer<typeof customerCreateWorkspaceSchema>): Promise<CustomerWorkspace>;
  listApplications(identity: Identity, value: { organizationId: string }): Promise<CustomerApplication[]>;
  createApplication(identity: Identity, value: z.infer<typeof customerCreateApplicationSchema>): Promise<CustomerApplication>;
  updateApplication(identity: Identity, value: z.infer<typeof customerUpdateApplicationSchema>): Promise<CustomerApplication>;
  listTargets(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerTarget[]>;
  enrollTarget(identity: Identity, value: z.infer<typeof customerEnrollTargetSchema>): Promise<CustomerEnrollment>;
  verifyTarget(identity: Identity, value: z.infer<typeof customerTargetIdSchema>): Promise<CustomerTarget>;
  revokeTarget(identity: Identity, value: z.infer<typeof customerTargetIdSchema>): Promise<CustomerTarget>;
  listSources(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerSourceSummary[]>;
  uploadSource(identity: Identity, value: z.infer<typeof customerUploadSourceSchema>): Promise<CustomerSourceSummary>;
  deleteSource(identity: Identity, value: { organizationId: string; applicationId: string; sourceSnapshotId: string }): Promise<unknown>;
  listReports(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerReportSummary[]>;
  getReport(identity: Identity, value: { organizationId: string; applicationId: string; reportId: string }): Promise<CustomerAssessmentReport>;
  queue(identity: Identity, value: z.infer<typeof customerQueueSchema>): Promise<{ jobId: string }>;
  job(identity: Identity, value: { organizationId: string; jobId: string }): Promise<unknown>;
}
const uuid = z.uuid().transform(id => id.toLowerCase());
const scopeSchema = z.object({ organizationId: uuid, applicationId: uuid });
const jobSchema = z.object({ id: uuid, applicationId: uuid, kind: z.string(), state: z.enum(['queued', 'running', 'succeeded', 'failed']), reportId: uuid.nullable(), reasonCode: z.string().nullable() });
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return parsed.data;
}
async function body(request: Request, max = 8_192): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, max))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}

export function createCustomerApi(options: {
  auth: AuthService; origin: string; services: CustomerServices | null;
  localAccounts?: LocalAccounts; registrationEnabled: boolean;
  providers: readonly { id: string; name: string; type: string }[];
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== options.origin) throw new HttpError(400, 'untrusted_host', 'El origen del servicio no coincide con su configuración.');
      if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, options.origin);
      if (request.method === 'GET' && url.pathname === '/api/customer/session') {
        const identity = options.auth.enabled ? await options.auth.identity(request) : null;
        const headers = new Headers();
        for (const cookie of identity?.cookies ?? []) headers.append('set-cookie', cookie);
        return json({ user: identity ? { id: identity.userId } : null, providers: options.providers,
          localAuthEnabled: Boolean(options.localAccounts), registrationEnabled: options.registrationEnabled }, 200, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/customer/register') {
        if (!options.registrationEnabled || !options.localAccounts) throw new HttpError(403, 'registration_disabled', 'El registro local no está habilitado.');
        return json(await options.localAccounts.register(parse(localRegistrationSchema, await body(request))), 201);
      }
      const session = await options.auth.identity(request);
      if (!session) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para acceder al espacio de trabajo.');
      const identity = { userId: session.userId };
      const services = options.services;
      if (!services) throw new HttpError(503, 'database_not_configured', 'La base de datos del servicio no está configurada.');
      const headers = new Headers();
      for (const cookie of session.cookies) headers.append('set-cookie', cookie);
      const send = (value: unknown, status = 200) => json(value, status, headers);
      if (url.pathname.startsWith('/api/customer/step-up/')) {
        const stepUp = services.stepUp;
        if (!stepUp) throw new HttpError(503, 'step_up_not_configured', 'La verificación en dos pasos no está configurada.');
        const response = await handleStepUpApi(request, identity, stepUp);
        if (response) return response;
      }
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 7 && pathParts[0] === 'api' && pathParts[1] === 'customer'
        && pathParts[2] === 'workspaces' && pathParts[4] === 'applications' && pathParts[6] === 'context') {
        if (!services.context) throw new HttpError(503, 'context_not_configured', 'El inventario de contexto no está configurado.');
        const contextResponse = await handleContextApi(request, identity, services.context, services.repositoryCatalog);
        if (contextResponse) {
          for (const cookie of session.cookies) contextResponse.headers.append('set-cookie', cookie);
          return contextResponse;
        }
      }
      if (url.pathname === '/api/customer/workspaces') {
        if (request.method === 'GET') return send(z.array(customerWorkspaceSchema).max(100).parse(await services.listWorkspaces(identity)));
        if (request.method === 'POST') return send(customerWorkspaceSchema.parse(await services.createWorkspace(identity, parse(customerCreateWorkspaceSchema, await body(request)))), 201);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'customer' || parts[2] !== 'workspaces') throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
      const organizationId = parse(uuid, parts[3]);
      if (parts.length === 6 && parts[4] === 'jobs' && request.method === 'GET') {
        const value = jobSchema.parse(await services.job(identity, { organizationId, jobId: parse(uuid, parts[5]) }));
        return send(value);
      }
      if (parts[4] !== 'applications') throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
      if (parts.length === 5) {
        if (request.method === 'GET') return send(z.array(customerApplicationSchema).max(100).parse(await services.listApplications(identity, { organizationId })));
        if (request.method === 'POST') {
          const value = parse(customerCreateApplicationSchema.omit({ organizationId: true }), await body(request));
          return send(customerApplicationSchema.parse(await services.createApplication(identity, { organizationId, ...value })), 201);
        }
      }
      const scope = parse(scopeSchema, { organizationId, applicationId: parts[5] });
      if (['monitoring', 'alerts', 'plans', 'repositories'].includes(parts[6] ?? '')) {
        const operations = services.operations;
        if (!operations) throw new HttpError(503, 'monitoring_not_configured', 'La vigilancia operativa no está configurada.');
        if (parts.length === 7 && parts[6] === 'repositories' && request.method === 'GET') {
          await operations.getConfig(identity, scope);
          return send(z.array(z.object({ key: z.string().max(128), label: z.string().max(200) }).strict()).max(100).parse(await services.repositoryCatalog?.(identity, scope) ?? []));
        }
        if (parts.length === 7 && parts[6] === 'monitoring') {
          if (request.method === 'GET') return send(operationCoverageSchema.parse(await operations.getCoverage(identity, scope)));
          if (request.method === 'PUT') {
            const value = parse(z.object(monitorConfigInputSchema.shape).omit({ organizationId: true, applicationId: true }).strict(), await body(request));
            return send(monitorConfigSchema.parse(await operations.configure(identity, { ...scope, ...value })));
          }
        }
        if (parts.length === 7 && parts[6] === 'alerts' && request.method === 'GET') return send(z.array(operationAlertSchema).max(100).parse(await operations.listAlerts(identity, scope)));
        if (parts.length === 8 && parts[6] === 'alerts' && request.method === 'PATCH') {
          const value = parse(z.object({ state: z.enum(['acknowledged', 'resolved']), resolution: z.string().min(1).max(2000).optional() }).strict(), await body(request));
          return send(operationAlertSchema.parse(await operations.updateAlert(identity, { ...scope, alertId: parse(uuid, parts[7]), state: value.state, ...(value.resolution === undefined ? {} : { resolution: value.resolution }) })));
        }
        if (parts.length === 7 && parts[6] === 'plans') {
          if (request.method === 'GET') return send(z.array(operationPlanSchema).max(100).parse(await operations.listPlans(identity, scope)));
          if (request.method === 'POST') {
            const value = parse(z.object({ kind: operationPlanKindSchema, observationIds: z.array(uuid).min(1).max(20) }).strict(), await body(request));
            return send(operationPlanSchema.parse(await operations.createPlan(identity, { ...scope, ...value })), 201);
          }
        }
        if (parts.length >= 9 && parts[6] === 'plans' && request.method === 'POST') {
          const fields = z.object({ revision: operationPlanBindingSchema.shape.revision, actionHash: operationPlanBindingSchema.shape.actionHash });
          if (parts.length === 10 && parts[8] === 'steps') {
            const value = parse(fields.extend({ attestation: z.string().min(1).max(2000) }).strict(), await body(request));
            return send(operationPlanSchema.parse(await operations.attestStep(identity, { ...scope, planId: parse(uuid, parts[7]), key: parse(operationPlanStepSchema.shape.key, parts[9]), ...value })));
          }
          if (parts.length === 9) {
            const value = parse(fields.strict(), await body(request));
            const binding = { ...scope, planId: parse(uuid, parts[7]), ...value };
            if (parts[8] === 'prepare') return send(operationPlanSchema.parse(await operations.requestPreparation(identity, binding)));
            if (parts[8] === 'readiness') return send(operationReadinessSchema.parse(await operations.checkReadiness(identity, binding)));
            if (parts[8] === 'execute') return send(await operations.requestExecution(identity, binding));
          }
        }
        throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
      }
      if (parts.length === 6 && request.method === 'PATCH') {
        const value = parse(z.object({ name: customerApplicationSchema.shape.name.optional(), archived: z.boolean().optional() }).strict().refine(value => value.name !== undefined || value.archived !== undefined), await body(request));
        return send(customerApplicationSchema.parse(await services.updateApplication(identity, { ...scope, ...value })));
      }
      if (parts.length === 7) {
        if (parts[6] === 'telemetry') {
          const telemetry = services.telemetry;
          if (!telemetry) throw new HttpError(503, 'telemetry_not_configured', 'La conexión de eventos no está configurada.');
          if (request.method === 'GET') return send(z.array(telemetryIntegrationSchema).max(20).parse(await telemetry.list(identity, scope)));
          if (request.method === 'POST') {
            parse(z.object({}).strict(), await body(request));
            return send(telemetryConnectionSchema.parse(await telemetry.connect(identity, scope)), 201);
          }
        }
        if (parts[6] === 'targets') {
          if (request.method === 'GET') return send(z.array(customerTargetSchema).max(20).parse(await services.listTargets(identity, scope)));
          if (request.method === 'POST') {
            const value = parse(customerEnrollTargetSchema.omit({ organizationId: true, applicationId: true }), await body(request));
            return send(customerEnrollmentSchema.parse(await services.enrollTarget(identity, { ...scope, ...value })), 201);
          }
        }
        if (parts[6] === 'sources') {
          if (request.method === 'GET') return send(z.array(customerSourceSummarySchema).max(20).parse(await services.listSources(identity, scope)));
          if (request.method === 'POST') {
            const value = parse(customerUploadSourceSchema.omit({ organizationId: true, applicationId: true }), await body(request, CUSTOMER_MAX_SOURCE_BYTES + 65_536));
            return send(customerSourceSummarySchema.parse(await services.uploadSource(identity, { ...scope, ...value })), 201);
          }
        }
        if (parts[6] === 'reports' && request.method === 'GET') return send(z.array(customerReportSummarySchema).max(50).parse(await services.listReports(identity, scope)));
        if (parts[6] === 'assessments' && request.method === 'POST') {
          const value = parse(z.object({ mode: customerAssessmentReportSchema.shape.mode, sourceSnapshotId: uuid.nullable(), targetId: uuid.nullable() }).strict(), await body(request));
          const input = parse(customerQueueSchema, { ...scope, ...value, idempotencyKey: request.headers.get('idempotency-key') });
          return send(z.object({ jobId: uuid }).strict().parse(await services.queue(identity, input)), 202);
        }
      }
      if (parts.length === 8 && parts[6] === 'telemetry' && request.method === 'DELETE') {
        if (!services.telemetry) throw new HttpError(503, 'telemetry_not_configured', 'La conexión de eventos no está configurada.');
        await services.telemetry.disable(identity, { ...scope, integrationId: parse(uuid, parts[7]) });
        headers.set('Cache-Control', 'private, no-store');
        return new Response(null, { status: 204, headers });
      }
      if (parts.length === 8 && parts[6] === 'reports' && request.method === 'GET') return send(customerAssessmentReportSchema.parse(await services.getReport(identity, { ...scope, reportId: parse(uuid, parts[7]) })));
      if (parts.length === 9 && parts[6] === 'reports' && ['recommendations', 'corrections'].includes(parts[8] ?? '')) {
        if (!services.corrections) throw new HttpError(503, 'corrections_not_configured', 'La preparación de correcciones no está configurada.');
        const reportScope = { ...scope, reportId: parse(uuid, parts[7]) };
        if (parts[8] === 'recommendations' && request.method === 'GET') return send(reportRecommendationsResponseSchema.parse(await services.corrections.recommendations(identity, reportScope)));
        if (parts[8] === 'corrections' && request.method === 'POST') {
          const selection = parse(prepareCorrectionRequestSchema, await body(request));
          return send(prepareCorrectionResponseSchema.parse(await services.corrections.prepare(identity, { ...reportScope, ...selection })), 201);
        }
      }
      if (parts.length === 8 && parts[6] === 'sources' && request.method === 'DELETE') {
        await services.deleteSource(identity, { ...scope, sourceSnapshotId: parse(uuid, parts[7]) });
        headers.set('Cache-Control', 'private, no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(null, { status: 204, headers });
      }
      if (parts.length === 9 && parts[6] === 'sources' && parts[8] === 'delete' && request.method === 'POST') {
        parse(z.object({}).strict(), await body(request));
        await services.deleteSource(identity, { ...scope, sourceSnapshotId: parse(uuid, parts[7]) });
        return send({ deleted: true });
      }
      if (parts.length === 9 && parts[6] === 'targets' && request.method === 'POST') {
        parse(z.object({}).strict(), await body(request));
        const value = { ...scope, targetId: parse(uuid, parts[7]) };
        if (parts[8] === 'verify') return send(customerTargetSchema.parse(await services.verifyTarget(identity, value)));
        if (parts[8] === 'revoke') return send(customerTargetSchema.parse(await services.revokeTarget(identity, value)));
      }
      throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
    } catch (error) {
      const response = errorResponse(error);
      if (new URL(request.url).pathname.startsWith('/api/customer/step-up/')) {
        const headers = new Headers(response.headers); headers.set('Cache-Control', 'private, no-store');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return response;
    }
  };
}
