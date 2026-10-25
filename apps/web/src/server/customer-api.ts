import { z } from 'zod';
import {
  customerCreateWorkspaceSchema, customerUpdateWorkspaceSchema, customerCreateApplicationSchema, customerUpdateApplicationSchema,
  customerEnrollTargetSchema, customerTargetIdSchema, customerUploadSourceSchema, customerQueueSchema,
  customerWorkspaceSchema, customerApplicationSchema, customerTargetSchema, customerEnrollmentSchema,
  customerSourceSummarySchema, customerReportSummarySchema, customerAssessmentReportSchema, CUSTOMER_MAX_SOURCE_BYTES,
  assessmentModeSchema, customerJobProgressSchema,
  CUSTOMER_MAX_CONTAINER_IMAGE_BYTES, customerContainerImageSummarySchema, customerContainerImageUploadMetadataSchema,
  type CustomerWorkspace, type CustomerApplication, type CustomerTarget, type CustomerEnrollment,
  type CustomerSourceSummary, type CustomerReportSummary, type CustomerAssessmentReport,
  type CustomerContainerImageSummary,
  telemetryIntegrationSchema, telemetryConnectionSchema,
  monitorConfigInputSchema, monitorConfigSchema, operationCoverageSchema, operationAlertSchema,
  operationPlanSchema, operationPlanKindSchema, operationPlanBindingSchema, operationPlanStepSchema, operationReadinessSchema,
  validationPublicProjectionSchema, validationSuiteConfigSchema, validationSuiteDefinitionSchema,
  decisionRecordPageSchema, decisionRecordQuerySchema,
  dependencyFixPreparationRequestSchema, dependencyFixPreparationResponseSchema,
  type DependencyFixPreparationRequest, type DependencyFixPreparationResponse,
  licensePolicySchema, workspaceLicensePolicySchema,
  configureInvestigationModelSchema, investigationModelProbeResultSchema, investigationModelSettingsSchema,
  providerConnectionSchema, investigationActionSchema, investigationRunSchema, investigationSubjectSchema,
  aiCorrectionSchema, aiCorrectionRequestSchema,
  workspaceRetentionPolicyInputSchema, workspaceRetentionPolicySchema,
} from '@gotchu/contracts';
import { type Identity, type Backend } from '@gotchu/backend';
import { prepareCorrectionRequestSchema, prepareCorrectionResponseSchema, reportRecommendationsResponseSchema, type PrepareCorrectionRequest, type PrepareCorrectionResponse, type ReportRecommendationsResponse } from '@gotchu/scenarios/contracts';
import type { AuthService } from './auth.js';
import { localRegistrationSchema, type LocalAccounts } from './local-accounts.js';
import { handleStepUpApi } from './step-up-api.js';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import { handleContextApi } from './context-api.js';
import { handleTriageApi } from './triage-api.js';
import { handleMembersApi } from './members-api.js';
import { handleActionsApi } from './actions-api.js';
import { createGitHubApi } from './github-api.js';
import type { SingleGitHubPublicApp } from './github-single-app.js';
import type { SingleAppGitHubBroker } from './github-broker-client.js';
import { handleWorkflowExceptionsApi } from './workflow-exceptions-api.js';
import { handleProtectionApi } from './protection-api.js';
import { handleNotificationsApi } from './notifications-api.js';
import type { createProviderConnections } from './provider-connections.js';
import type { createOpenRouterLogins } from './openrouter-login.js';

export interface CustomerServices {
  stepUp?: NonNullable<Backend['stepUp']>;
  corrections?: {
    recommendations(identity: Identity, input: { organizationId: string; applicationId: string; reportId: string }): Promise<ReportRecommendationsResponse>;
    prepare(identity: Identity, input: PrepareCorrectionRequest & { organizationId: string; applicationId: string; reportId: string }): Promise<PrepareCorrectionResponse>;
    prepareDependencyFix(identity: Identity, input: DependencyFixPreparationRequest & { organizationId: string; applicationId: string; reportId: string }): Promise<DependencyFixPreparationResponse>;
    validationStatus?(identity: Identity, input: { organizationId: string; applicationId: string; candidateSourceId: string }): Promise<unknown>;
  };
  validations?: Backend['validations'];
  telemetry?: Backend['telemetry'];
  protection?: Backend['protection'];
  context?: Backend['context'];
  members?: Backend['members'];
  operations?: Backend['operations'];
  decisionRecords?: Backend['decisionRecords'];
  notifications?: Backend['notifications'];
  retention?: Backend['retention'];
  triage?: Backend['triage'];
  investigationModels?: Backend['investigationModels'];
  investigations?: Backend['investigations'];
  aiCorrections?: Backend['aiCorrections'];
  getLicensePolicy?: Backend['customers']['getLicensePolicy'];
  updateLicensePolicy?: Backend['customers']['updateLicensePolicy'];
  exportSbom?: Backend['customers']['exportSbom'];
  actions?: Backend['actions'];
  github?: Backend['github'];
  workflowExceptions?: Backend['workflowExceptions'];
  repositoryCatalog?: (identity: Identity, scope: { organizationId: string; applicationId: string }) => Promise<Array<{ key: string; label: string }>>;
  listWorkspaces(identity: Identity): Promise<CustomerWorkspace[]>;
  createWorkspace(identity: Identity, value: z.infer<typeof customerCreateWorkspaceSchema>): Promise<CustomerWorkspace>;
  updateWorkspace(identity: Identity, value: z.infer<typeof customerUpdateWorkspaceSchema>): Promise<CustomerWorkspace>;
  listApplications(identity: Identity, value: { organizationId: string }): Promise<CustomerApplication[]>;
  createApplication(identity: Identity, value: z.infer<typeof customerCreateApplicationSchema>): Promise<CustomerApplication>;
  updateApplication(identity: Identity, value: z.infer<typeof customerUpdateApplicationSchema>): Promise<CustomerApplication>;
  listTargets(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerTarget[]>;
  enrollTarget(identity: Identity, value: z.infer<typeof customerEnrollTargetSchema>): Promise<CustomerEnrollment>;
  revokeTarget(identity: Identity, value: z.infer<typeof customerTargetIdSchema>): Promise<CustomerTarget>;
  listSources(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerSourceSummary[]>;
  uploadSource(identity: Identity, value: z.infer<typeof customerUploadSourceSchema>): Promise<CustomerSourceSummary>;
  uploadCapturedSource?: Backend['customers']['uploadCapturedSource'];
  deleteSource(identity: Identity, value: { organizationId: string; applicationId: string; sourceSnapshotId: string }): Promise<unknown>;
  listContainerImages(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerContainerImageSummary[]>;
  uploadContainerImage(identity: Identity, value: { organizationId: string; applicationId: string; label: string; authorized: true }, bytes: Uint8Array): Promise<CustomerContainerImageSummary>;
  deleteContainerImage(identity: Identity, value: { organizationId: string; applicationId: string; imageId: string }): Promise<unknown>;
  listReports(identity: Identity, value: { organizationId: string; applicationId: string }): Promise<CustomerReportSummary[]>;
  getReport(identity: Identity, value: { organizationId: string; applicationId: string; reportId: string }): Promise<CustomerAssessmentReport>;
  recordReportDownload(identity: Identity, value: { organizationId: string; applicationId: string; reportId: string }): Promise<void>;
  queue(identity: Identity, value: z.infer<typeof customerQueueSchema>): Promise<{ jobId: string }>;
  job(identity: Identity, value: { organizationId: string; jobId: string }): Promise<unknown>;
}
const uuid = z.uuid().transform(id => id.toLowerCase());
const scopeSchema = z.object({ organizationId: uuid, applicationId: uuid });
const isoDate = z.coerce.date().transform(value => value.toISOString());
const jobSchema = z.object({
  id: uuid, applicationId: uuid, kind: z.string(), state: z.enum(['queued', 'running', 'succeeded', 'failed']), reportId: uuid.nullable(), reasonCode: z.string().nullable(),
  mode: assessmentModeSchema.nullable(), inputKind: z.enum(['source_snapshot', 'container_image']).nullable(),
  createdAt: isoDate, completedAt: isoDate.nullable(), progress: customerJobProgressSchema,
});
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
  selfHostSetup?: boolean;
  providers: readonly { id: string; name: string; type: string }[];
  githubAppFile?: string; githubAppSlug?: string;
  singleAppGitHub?: { publicApp: SingleGitHubPublicApp; broker: SingleAppGitHubBroker };
  providerConnections?: ReturnType<typeof createProviderConnections>;
  openRouterLogins?: ReturnType<typeof createOpenRouterLogins>;
}) {
  const handleGitHub = createGitHubApi({ origin: options.origin, ...(options.githubAppFile ? { appFile: options.githubAppFile } : {}), ...(options.githubAppSlug ? { appSlug: options.githubAppSlug } : {}), ...(options.singleAppGitHub ? { singleApp: options.singleAppGitHub } : {}),
    services: options.services?.github ? { github: options.services.github, uploadSource: options.services.uploadSource,
      ...(options.services.uploadCapturedSource ? { uploadCapturedSource: options.services.uploadCapturedSource } : {}), queue: options.services.queue } : null });
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== options.origin) throw new HttpError(400, 'untrusted_host', 'El origen del servicio no coincide con su configuración.');
      if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, options.origin);
      if (request.method === 'GET' && url.pathname === '/api/customer/session') {
        const identity = options.auth.enabled ? await options.auth.identity(request) : null;
        const headers = new Headers();
        for (const cookie of identity?.cookies ?? []) headers.append('set-cookie', cookie);
        return json({ user: identity ? { id: identity.userId, ...(identity.displayName ? { displayName: identity.displayName } : {}) } : null, providers: options.providers,
          localAuthEnabled: Boolean(options.localAccounts), registrationEnabled: options.registrationEnabled }, 200, headers);
      }
      if (url.pathname === '/api/customer/github/callback' || url.pathname === '/api/customer/github/connect' || url.pathname === '/api/customer/github/choose'
        || /^\/api\/customer\/workspaces\/[^/]+\/(?:applications\/[^/]+\/)?github(?:\/|$)/.test(url.pathname)) {
        const githubSession = await options.auth.identity(request);
        const githubIdentity = githubSession ? { userId: githubSession.userId } : null;
        const response = await handleGitHub(request, githubIdentity, githubSession?.cookies ?? []);
        if (response) return response;
      }
      if (request.method === 'POST' && url.pathname === '/api/customer/register') {
        if (!options.registrationEnabled || !options.localAccounts) throw new HttpError(403, 'registration_disabled', 'El registro local no está habilitado.');
        return json(await options.localAccounts.register(parse(localRegistrationSchema, await body(request))), 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/customer/setup') {
        if (!options.selfHostSetup || !options.localAccounts) throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
        return json(await options.localAccounts.bootstrap(await body(request, 16_384)), 201);
      }
      const session = await options.auth.identity(request);
      if (!session) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para acceder al espacio de trabajo.');
      if (request.method === 'POST' && url.pathname === '/api/customer/workspaces' && options.selfHostSetup
        && (!options.localAccounts || !await options.localAccounts.bootstrapComplete())) {
        throw new HttpError(403, 'self_host_setup_required', 'Completa primero la configuración inicial de /setup para crear el primer Owner.');
      }
      const identity = { userId: session.userId };
      const services = options.services;
      if (!services) throw new HttpError(503, 'database_not_configured', 'La base de datos del servicio no está configurada.');
      const headers = new Headers();
      for (const cookie of session.cookies) headers.append('set-cookie', cookie);
      const send = (value: unknown, status = 200) => json(value, status, headers);
      if (url.pathname === '/api/customer/model-provider/openrouter/callback' && request.method === 'GET') {
        if (!options.openRouterLogins) throw new HttpError(503, 'provider_login_not_configured', 'La conexión no está configurada.');
        await options.openRouterLogins.complete(identity, url);
        headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'private, no-store');
        headers.set('Referrer-Policy', 'no-referrer'); headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorización recibida · Gotchu</title><main><h1>Autorización recibida</h1><p>Vuelve a la pestaña de Gotchu. La conexión se completará automáticamente.</p><a href="/dashboard">Volver a Gotchu</a></main></html>', { headers });
      }
      const retentionParts=url.pathname.split('/').filter(Boolean);
      if(retentionParts.length===5&&retentionParts[0]==='api'&&retentionParts[1]==='customer'&&retentionParts[2]==='workspaces'&&retentionParts[4]==='retention'){
        if(!services.retention)throw new HttpError(503,'retention_not_configured','La retención no está configurada.');
        const organizationId=parse(uuid,retentionParts[3]);
        if(request.method==='GET')return send(workspaceRetentionPolicySchema.parse(await services.retention.getPolicy(identity,{organizationId})));
        if(request.method==='PUT'){
          const policy=parse(workspaceRetentionPolicyInputSchema,await body(request));
          return send(workspaceRetentionPolicySchema.parse(await services.retention.updatePolicy(identity,{organizationId,...policy})));
        }
      }
      const notificationParts=url.pathname.split('/').filter(Boolean);
      if(notificationParts.length>=5&&notificationParts[0]==='api'&&notificationParts[1]==='customer'&&notificationParts[2]==='workspaces'&&notificationParts[4]==='notifications'){
        if(!services.notifications)throw new HttpError(503,'notifications_not_configured','Las notificaciones no están configuradas.');
        const response=await handleNotificationsApi(request,identity,services.notifications,options.origin);
        if(response){for(const cookie of session.cookies)response.headers.append('set-cookie',cookie);return response;}
      }
      const memberPath = url.pathname === '/api/customer/invitations/accept'
        || /^\/api\/customer\/workspaces\/[^/]+\/(members|invitations)(\/|$)/.test(url.pathname);
      if (memberPath) {
        if (!services.members) throw new HttpError(503, 'members_not_configured', 'La gestión de miembros no está configurada.');
        const isAccept = url.pathname === '/api/customer/invitations/accept' && request.method === 'POST';
        const email = isAccept ? await options.auth.accountEmail(session.userId) : null;
        const response = await handleMembersApi(request, identity, email, services.members, options.origin);
        if (response) {
          for (const cookie of session.cookies) response.headers.append('set-cookie', cookie);
          return response;
        }
      }
      if (url.pathname.startsWith('/api/customer/step-up/')) {
        const stepUp = services.stepUp;
        if (!stepUp) throw new HttpError(503, 'step_up_not_configured', 'La verificación en dos pasos no está configurada.');
        const response = await handleStepUpApi(request, identity, stepUp);
        if (response) {
          for (const cookie of session.cookies) response.headers.append('set-cookie', cookie);
          return response;
        }
      }
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 7 && pathParts[0] === 'api' && pathParts[1] === 'customer'
        && pathParts[2] === 'workspaces' && pathParts[4] === 'applications' && pathParts[6] === 'protection') {
        if (!services.protection) throw new HttpError(503, 'protection_not_configured', 'La protección runtime no está configurada.');
        const protectionResponse = await handleProtectionApi(request, identity, services.protection, pathParts);
        if (protectionResponse) {
          for (const cookie of session.cookies) protectionResponse.headers.append('set-cookie', cookie);
          return protectionResponse;
        }
      }
      if (pathParts.length >= 7 && pathParts[0] === 'api' && pathParts[1] === 'customer'
        && pathParts[2] === 'workspaces' && pathParts[4] === 'applications' && pathParts[6] === 'context') {
        if (!services.context) throw new HttpError(503, 'context_not_configured', 'El inventario de contexto no está configurado.');
        const contextResponse = await handleContextApi(request, identity, services.context, services.repositoryCatalog);
        if (contextResponse) {
          for (const cookie of session.cookies) contextResponse.headers.append('set-cookie', cookie);
          return contextResponse;
        }
      }
      if (pathParts.length >= 7 && pathParts[0] === 'api' && pathParts[1] === 'customer'
        && pathParts[2] === 'workspaces' && pathParts[4] === 'applications' && pathParts[6] === 'actions') {
        if (!services.actions) throw new HttpError(503, 'actions_not_configured', 'Las propuestas de acciones no están configuradas.');
        const actionResponse = await handleActionsApi(request, identity, services.actions, pathParts);
        if (actionResponse) {
          for (const cookie of session.cookies) actionResponse.headers.append('set-cookie', cookie);
          return actionResponse;
        }
      }
      if (pathParts.length >= 7 && pathParts[0] === 'api' && pathParts[1] === 'customer'
        && pathParts[2] === 'workspaces' && pathParts[4] === 'applications' && pathParts[6] === 'workflow-exceptions') {
        if (!services.workflowExceptions) throw new HttpError(503, 'workflow_exceptions_not_configured', 'Las excepciones de workflows no están configuradas.');
        const exceptionResponse = await handleWorkflowExceptionsApi(request, identity, services.workflowExceptions, pathParts);
        if (exceptionResponse) {
          for (const cookie of session.cookies) exceptionResponse.headers.append('set-cookie', cookie);
          return exceptionResponse;
        }
      }
      if (url.pathname === '/api/customer/workspaces') {
        if (request.method === 'GET') return send(z.array(customerWorkspaceSchema).max(100).parse(await services.listWorkspaces(identity)));
        if (request.method === 'POST') return send(customerWorkspaceSchema.parse(await services.createWorkspace(identity, parse(customerCreateWorkspaceSchema, await body(request)))), 201);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 7 && parts[0] === 'api' && parts[1] === 'customer' && parts[2] === 'workspaces' && parts[4] === 'applications' && parts[6] === 'validation-suites' && request.method === 'POST') {
        if (!services.validations) throw new HttpError(503, 'validations_not_configured', 'La validación independiente no está configurada.');
        const value = parse(validationSuiteConfigSchema.omit({ organizationId: true, applicationId: true }), await body(request));
        const validationScope = parse(scopeSchema, { organizationId: parts[3], applicationId: parts[5] });
        return send(validationSuiteDefinitionSchema.parse(await services.validations.configureSuite(identity, { ...validationScope, ...value })));
      }
      if (parts.length === 8 && parts[0] === 'api' && parts[1] === 'customer' && parts[2] === 'workspaces' && parts[4] === 'applications' && parts[6] === 'corrections' && request.method === 'GET') {
        if (!services.corrections?.validationStatus) throw new HttpError(503, 'corrections_not_configured', 'La validación de correcciones no está configurada.');
        const validationScope = parse(scopeSchema, { organizationId: parts[3], applicationId: parts[5] });
        return send(validationPublicProjectionSchema.nullable().parse(await services.corrections.validationStatus(identity, { ...validationScope, candidateSourceId: parse(uuid, parts[7]) })));
      }
      if (parts[0] !== 'api' || parts[1] !== 'customer' || parts[2] !== 'workspaces') throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
      const organizationId = parse(uuid, parts[3]);
      if (parts[4] === 'investigation-model' && (parts[5] === 'codex' || parts[5] === 'claude_code' || parts[5] === 'openrouter') && parts[6] === 'connections') {
        if (!options.providerConnections) throw new HttpError(503, 'provider_login_not_configured', 'La autorización desde el navegador está disponible en instalaciones locales de Gotchu. Los proveedores de suscripción necesitan su CLI oficial instalado.');
        if (parts.length === 7 && request.method === 'POST') {
          parse(z.object({}).strict(), await body(request));
          return send(providerConnectionSchema.parse(await options.providerConnections.start(identity, organizationId, parts[5])), 201);
        }
        if (parts.length === 8 && (request.method === 'POST' || request.method === 'DELETE')) {
          const input = parse(z.object({ authorizationCode: z.string().min(16).max(513).optional() }).strict(), await body(request));
          if (request.method === 'DELETE' && input.authorizationCode) throw new HttpError(400, 'invalid_input', 'Cancelar no requiere código.');
          return send(providerConnectionSchema.parse(await options.providerConnections.get(identity, organizationId, parse(uuid, parts[7]), request.method === 'DELETE', parts[5], input.authorizationCode)));
        }
        throw new HttpError(405, 'method_not_allowed', 'Método no permitido.');
      }
      if (parts.length === 5 && parts[4] === 'investigation-model') {
        const modelSettings = services.investigationModels;
        if (!modelSettings) throw new HttpError(503, 'investigation_model_not_configured', 'La configuración del modelo no está disponible.');
        if (request.method === 'GET') return send(investigationModelSettingsSchema.parse(await modelSettings.get(identity, { organizationId })));
        if (request.method === 'PUT') {
          const value = parse(configureInvestigationModelSchema.extend({ clearApiKey: z.boolean().optional() }).strict(), await body(request, 12_288));
          return send(investigationModelSettingsSchema.parse(await modelSettings.configure(identity, { organizationId, ...value })));
        }
        if (request.method === 'DELETE') return send(investigationModelSettingsSchema.parse(await modelSettings.disable(identity, { organizationId })));
      }
      if (parts.length === 6 && parts[4] === 'investigation-model' && parts[5] === 'test' && request.method === 'POST') {
        const modelSettings = services.investigationModels;
        if (!modelSettings) throw new HttpError(503, 'investigation_model_not_configured', 'La configuración del modelo no está disponible.');
        return send(investigationModelProbeResultSchema.parse(await modelSettings.testConnection(identity, { organizationId })));
      }
      if (parts.length === 5 && parts[4] === 'license-policy') {
        if (request.method === 'GET') {
          if (!services.getLicensePolicy) throw new HttpError(503, 'license_policy_not_configured', 'La política de licencias no está configurada.');
          return send(workspaceLicensePolicySchema.parse(await services.getLicensePolicy(identity, { organizationId })));
        }
        if (request.method === 'PUT') {
          if (!services.updateLicensePolicy) throw new HttpError(503, 'license_policy_not_configured', 'La política de licencias no está configurada.');
          const value = parse(licensePolicySchema, await body(request));
          return send(workspaceLicensePolicySchema.parse(await services.updateLicensePolicy(identity, { organizationId, policy: value })));
        }
      }
      if (parts.length === 4 && request.method === 'PATCH') {
        const value = parse(customerUpdateWorkspaceSchema.omit({ organizationId: true }), await body(request));
        return send(customerWorkspaceSchema.parse(await services.updateWorkspace(identity, { organizationId, ...value })));
      }
      if (parts.length === 5 && parts[4] === 'decision-records' && request.method === 'GET') {
        if (!services.decisionRecords) throw new HttpError(503, 'decision_records_not_configured', 'El historial de decisiones no está configurado.');
        const query = parse(decisionRecordQuerySchema, Object.fromEntries(url.searchParams.entries()));
        return send(decisionRecordPageSchema.parse(await services.decisionRecords.list(identity, { organizationId, ...query })));
      }
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
      if (parts[6] === 'incidents') {
        if (!services.triage) throw new HttpError(503,'triage_not_configured','La clasificación de incidentes no está configurada.');
        const response = await handleTriageApi(request,identity,services.triage,scope,parts);
        if (response !== null) return send(response);
      }
      if (parts[6] === 'investigations') {
        const investigations = services.investigations;
        if (!investigations) throw new HttpError(503, 'investigations_not_configured', 'Las investigaciones no están disponibles.');
        if (parts.length === 7 && request.method === 'GET') return send(z.array(investigationRunSchema).max(50).parse(await investigations.list(identity, scope)));
        if (parts.length === 7 && request.method === 'POST') {
          const value = parse(z.object({ subject: investigationSubjectSchema }).strict(), await body(request));
          return send(investigationActionSchema.parse(await investigations.request(identity, { ...scope, ...value })), 202);
        }
        if (parts.length === 9 && request.method === 'POST') {
          parse(z.object({}).strict(), await body(request));
          const action = parts[8];
          if (action === 'cancel') return send(investigationActionSchema.parse(await investigations.cancel(identity, { ...scope, jobId: parse(uuid, parts[7]) })));
          if (action === 'resume') return send(investigationActionSchema.parse(await investigations.resume(identity, { ...scope, jobId: parse(uuid, parts[7]) })));
        }
        throw new HttpError(404, 'not_found', 'Ruta de investigación no encontrada.');
      }
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
        if (parts[6] === 'container-images') {
          if (request.method === 'GET') return send(z.array(customerContainerImageSummarySchema).max(20).parse(await services.listContainerImages(identity, scope)));
          if (request.method === 'POST') {
            const mime = request.headers.get('content-type')?.split(';')[0]?.trim();
            if (!['application/x-tar', 'application/octet-stream', 'application/vnd.oci.image.layout.v1.tar'].includes(mime ?? '')) {
              throw new HttpError(415, 'content_type', 'Sube un archivo tar OCI o Docker con un tipo de contenido admitido.');
            }
            const metadata = parse(customerContainerImageUploadMetadataSchema, {
              label: url.searchParams.get('label'), authorized: url.searchParams.get('authorized') === 'true' ? true : undefined,
            });
            const archive = await readBoundedBody(request, CUSTOMER_MAX_CONTAINER_IMAGE_BYTES, 30_000);
            return send(customerContainerImageSummarySchema.parse(await services.uploadContainerImage(identity, { ...scope, ...metadata }, archive)), 201);
          }
        }
        if (parts[6] === 'reports' && request.method === 'GET') return send(z.array(customerReportSummarySchema).max(50).parse(await services.listReports(identity, scope)));
        if (parts[6] === 'assessments' && request.method === 'POST') {
          const value = parse(z.object({
            mode: customerAssessmentReportSchema.shape.mode, sourceSnapshotId: uuid.nullable(), targetId: uuid.nullable(),
            inputKind: z.enum(['source_snapshot', 'container_image']).optional(),
            containerImage: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('archive'), imageId: uuid }).strict(),
              z.object({ kind: z.literal('registry'), reference: z.string().max(512) }).strict(),
            ]).nullable().optional(),
          }).strict(), await body(request));
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
      if (parts.length === 9 && parts[6] === 'reports' && parts[8] === 'sbom.cyclonedx.json' && request.method === 'GET') {
        if (!services.exportSbom) throw new HttpError(503, 'sbom_not_configured', 'La exportación SBOM no está configurada.');
        const reportId = parse(uuid, parts[7]);
        const sbom = await services.exportSbom(identity, { ...scope, reportId });
        headers.set('Cache-Control', 'private, no-store');
        headers.set('Content-Type', 'application/vnd.cyclonedx+json');
        headers.set('Content-Disposition', `attachment; filename="gotchu-${reportId}.cdx.json"`);
        return new Response(JSON.stringify(sbom), { status: 200, headers });
      }
      if (parts.length === 9 && parts[6] === 'reports' && parts[8] === 'download' && request.method === 'POST') {
        parse(z.object({}).strict(), await body(request));
        await services.recordReportDownload(identity, { ...scope, reportId: parse(uuid, parts[7]) });
        headers.set('Cache-Control', 'private, no-store');
        return new Response(null, { status: 204, headers });
      }
      if (parts[6] === 'reports' && parts[8] === 'ai-corrections') {
        if (!services.aiCorrections) throw new HttpError(503, 'corrections_not_configured', 'La preparación con IA no está configurada.');
        const reportScope = { ...scope, reportId: parse(uuid, parts[7]) };
        if (parts.length === 9 && request.method === 'GET') return send(z.array(aiCorrectionSchema).max(50).parse(await services.aiCorrections.list(identity, reportScope)));
        if (parts.length === 9 && request.method === 'POST') {
          const selection = parse(aiCorrectionRequestSchema, await body(request));
          return send(aiCorrectionSchema.parse(await services.aiCorrections.request(identity, { ...reportScope, ...selection })), 201);
        }
        if (parts.length === 10 && request.method === 'DELETE') return send(aiCorrectionSchema.parse(await services.aiCorrections.cancel(identity, { ...reportScope, correctionId: parse(uuid, parts[9]) })));
      }
      if (parts.length === 9 && parts[6] === 'reports' && ['recommendations', 'corrections', 'dependency-fixes'].includes(parts[8] ?? '')) {
        if (!services.corrections) throw new HttpError(503, 'corrections_not_configured', 'La preparación de correcciones no está configurada.');
        const reportScope = { ...scope, reportId: parse(uuid, parts[7]) };
        if (parts[8] === 'recommendations' && request.method === 'GET') return send(reportRecommendationsResponseSchema.parse(await services.corrections.recommendations(identity, reportScope)));
        if (parts[8] === 'corrections' && request.method === 'POST') {
          const selection = parse(prepareCorrectionRequestSchema, await body(request));
          return send(prepareCorrectionResponseSchema.parse(await services.corrections.prepare(identity, { ...reportScope, ...selection })), 201);
        }
        if (parts[8] === 'dependency-fixes' && request.method === 'POST') {
          const selection = parse(dependencyFixPreparationRequestSchema, await body(request));
          return send(dependencyFixPreparationResponseSchema.parse(await services.corrections.prepareDependencyFix(identity, { ...reportScope, ...selection })), 201);
        }
      }
      if (parts.length === 8 && parts[6] === 'sources' && request.method === 'DELETE') {
        await services.deleteSource(identity, { ...scope, sourceSnapshotId: parse(uuid, parts[7]) });
        headers.set('Cache-Control', 'private, no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(null, { status: 204, headers });
      }
      if (parts.length === 8 && parts[6] === 'container-images' && request.method === 'DELETE') {
        await services.deleteContainerImage(identity, { ...scope, imageId: parse(uuid, parts[7]) });
        headers.set('Cache-Control', 'private, no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(null, { status: 204, headers });
      }
      if (parts.length === 9 && parts[6] === 'sources' && parts[8] === 'delete' && request.method === 'POST') {
        parse(z.object({}).strict(), await body(request));
        await services.deleteSource(identity, { ...scope, sourceSnapshotId: parse(uuid, parts[7]) });
        return send({ deleted: true });
      }
      if (parts.length === 9 && parts[6] === 'targets' && parts[8] === 'revoke' && request.method === 'POST') {
        parse(z.object({}).strict(), await body(request));
        const value = { ...scope, targetId: parse(uuid, parts[7]) };
        return send(customerTargetSchema.parse(await services.revokeTarget(identity, value)));
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
