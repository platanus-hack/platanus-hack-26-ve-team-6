import {
  customerApplicationSchema,
  customerAssessmentReportSchema,
  customerCreateApplicationSchema,
  customerCreateWorkspaceSchema,
  customerEnrollTargetSchema,
  customerScanProfileSchema,
  customerEnrollmentSchema,
  customerReportSummarySchema,
  customerSourceSummarySchema,
  customerTargetSchema,
  customerWorkspaceSchema,
  customerQueueSchema,
  customerUpdateApplicationSchema,
  customerUploadSourceSchema,
  type AssessmentMode,
  type CustomerApplication,
  type CustomerAssessmentReport,
  type CustomerReportSummary,
  type CustomerSourceSummary,
  type CustomerTarget,
  type CustomerWorkspace,
  githubConnectionSchema,
  githubRepositorySchema,
} from '@gotchu/contracts';
import {
  prepareCorrectionRequestSchema,
  prepareCorrectionResponseSchema,
  reportRecommendationsParamsSchema,
  reportRecommendationsResponseSchema,
  type PrepareCorrectionRequest,
} from '@gotchu/scenarios/contracts';
import { z } from 'zod';

const customerSessionSchema = z.object({
  user: z.object({ id: z.string().min(1).max(256) }).strict().nullable(),
  providers: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(100), type: z.string().min(1).max(32) }).strict()),
  localAuthEnabled: z.boolean(),
  registrationEnabled: z.boolean(),
}).strict();
const customerJobSchema = z.object({
  id: z.uuid(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  applicationId: z.uuid(),
  kind: z.string().min(1).max(64),
  reportId: z.uuid().nullable(),
  reasonCode: z.string().max(256).nullable(),
}).strict();
const queuedAssessmentSchema = z.object({ jobId: z.uuid() }).strict();
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() }).passthrough();
const workspaceListSchema = z.array(customerWorkspaceSchema);
const applicationListSchema = z.array(customerApplicationSchema);
const targetListSchema = z.array(customerTargetSchema);
const sourceListSchema = z.array(customerSourceSummarySchema);
const reportListSchema = z.array(customerReportSummarySchema);
const csrfSchema = z.object({ csrfToken: z.string().min(1) }).passthrough();
const registeredAccountSchema = z.object({ id: z.string().min(1).max(256) }).strict();
const deletedSourceSchema = z.union([z.undefined(), z.object({ deleted: z.literal(true) }).strict()]);
const actionProposalSchema = z.object({ id: z.uuid(), actionHash: z.string().regex(/^[0-9a-f]{64}$/), kind: z.string(), state: z.enum(['proposed','eligible','ineligible','approved','expired','invalidated','executing','succeeded','failed','uncertain','reconciliation_required']), effect: z.string(), scope: z.string(), target: z.unknown(), cost: z.object({ state: z.literal('unknown'), amount: z.null() }).strict(), diff: z.object({ path: z.string(), summary: z.string() }).strict().nullable(), validations: z.array(z.object({ label: z.string(), state: z.enum(['pending','passed','failed','unknown']) }).strict()), limits: z.array(z.string()), blockingReasons: z.array(z.string()), createdAt: z.iso.datetime() }).strict();
const actionListSchema = z.array(actionProposalSchema).max(100);
const actionEligibilitySchema = z.object({ status: z.enum(['eligible','ineligible']), blockingReasons: z.array(z.string()) }).strict();
const githubSelectSchema = z.object({ repository: githubRepositorySchema, link: z.object({ id: z.uuid(), applicationId: z.uuid(), repositoryKey: z.string(), fullName: z.string(), defaultBranch: z.string(), readAccess: z.literal('granted'), writeAccess: z.literal('not_granted') }).strict(), source: customerSourceSummarySchema, jobId: z.uuid() }).strict();

export type CustomerSession = z.infer<typeof customerSessionSchema>;
export type CustomerJob = z.infer<typeof customerJobSchema>;
export type CustomerScanProfile = z.infer<typeof customerScanProfileSchema>;

export class CustomerApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CustomerApiError';
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, expectedStatus?: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CustomerApiError(0, 'timeout', 'La solicitud tardó demasiado. Comprueba tu conexión e inténtalo de nuevo.');
    }
    throw new CustomerApiError(0, 'network_error', 'No se pudo conectar con Gotchu. Comprueba tu conexión e inténtalo de nuevo.');
  }

  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new CustomerApiError(response.status, 'invalid_response', 'El servidor devolvió una respuesta que no se pudo leer.');
  }

  if (!response.ok) {
    const error = errorSchema.safeParse(payload);
    throw new CustomerApiError(
      response.status,
      error.success ? error.data.error.code : 'request_failed',
      error.success ? error.data.error.message : 'No se pudo completar la solicitud.',
    );
  }

  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new CustomerApiError(response.status, 'unexpected_status', 'El servidor devolvió un estado distinto al esperado.');
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new CustomerApiError(response.status, 'invalid_response', 'El servidor devolvió datos que no coinciden con el contrato esperado.');
  }
  return result.data;
}

async function csrfToken() {
  return request('/api/auth/csrf', csrfSchema).then(value => value.csrfToken);
}

async function postAuthForm(path: string, fields: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'X-Auth-Return-Redirect': '1' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CustomerApiError(0, 'auth_network_error', 'No se pudo completar el inicio de sesión. Inténtalo de nuevo.');
  }
  if (!response.ok) throw new CustomerApiError(response.status, 'auth_failed', 'No se pudo completar el inicio de sesión. Comprueba tus datos e inténtalo de nuevo.');
}

function jsonBody(body: unknown): Pick<RequestInit, 'headers' | 'body'> {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const organizationPath = (organizationId: string) => `/api/customer/workspaces/${encodeURIComponent(organizationId)}`;
const applicationPath = (organizationId: string, applicationId: string) => `${organizationPath(organizationId)}/applications/${encodeURIComponent(applicationId)}`;

export const customerApi = {
  session: () => request('/api/customer/session', customerSessionSchema),
  async signIn(email: string, password: string) {
    const csrf = await csrfToken();
    await postAuthForm('/api/auth/callback/credentials', { csrfToken: csrf, email, password, callbackUrl: '/dashboard', json: 'true' });
    const session = await customerApi.session();
    if (!session.user) throw new CustomerApiError(401, 'credentials_rejected', 'El correo o la contraseña no son correctos.');
    return session;
  },
  async register(email: string, password: string) {
    const csrf = await csrfToken();
    const account = await request('/api/customer/register', registeredAccountSchema, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ email, password }),
    });
    if (!account.id) throw new CustomerApiError(500, 'registration_failed', 'No se pudo crear la cuenta.');
    return customerApi.signIn(email, password);
  },
  async signOut() {
    const csrf = await csrfToken();
    await postAuthForm('/api/auth/signout', { csrfToken: csrf, callbackUrl: '/dashboard', json: 'true' });
    const session = await customerApi.session();
    if (session.user) throw new CustomerApiError(401, 'signout_rejected', 'No se pudo cerrar la sesión. Inténtalo de nuevo.');
    return session;
  },
  workspaces: () => request('/api/customer/workspaces', workspaceListSchema),
  createWorkspace: (name: string) => {
    const input = customerCreateWorkspaceSchema.parse({ name });
    return request('/api/customer/workspaces', customerWorkspaceSchema, { method: 'POST', ...jsonBody(input) });
  },
  applications: (organizationId: string) => request(`${organizationPath(organizationId)}/applications`, applicationListSchema),
  createApplication: (organizationId: string, name: string) => {
    const input = customerCreateApplicationSchema.parse({ organizationId, name });
    return request(`${organizationPath(input.organizationId)}/applications`, customerApplicationSchema, { method: 'POST', ...jsonBody({ name: input.name }) });
  },
  updateApplication: (input: { organizationId: string; applicationId: string; name?: string; archived?: boolean }) => {
    const { organizationId, applicationId, name, archived } = input;
    const validated = customerUpdateApplicationSchema.parse({ organizationId, applicationId, ...(name !== undefined ? { name } : {}), ...(archived !== undefined ? { archived } : {}) });
    return request(applicationPath(validated.organizationId, validated.applicationId), customerApplicationSchema, {
      method: 'PATCH', ...jsonBody({ ...(validated.name !== undefined ? { name: validated.name } : {}), ...(validated.archived !== undefined ? { archived: validated.archived } : {}) }),
    });
  },
  targets: (organizationId: string, applicationId: string) => request(`${applicationPath(organizationId, applicationId)}/targets`, targetListSchema),
  enrollTarget: (input: { organizationId: string; applicationId: string; origin: string; authorized: true; scanProfile?: CustomerScanProfile }) => {
    const { organizationId, applicationId, origin, authorized, scanProfile } = input;
    const validated = customerEnrollTargetSchema.parse({ organizationId, applicationId, origin, authorized, ...(scanProfile === undefined ? {} : { scanProfile }) });
    return request(`${applicationPath(organizationId, applicationId)}/targets`, customerEnrollmentSchema, {
      method: 'POST', ...jsonBody({ origin: validated.origin, authorized: validated.authorized, ...(validated.scanProfile === undefined ? {} : { scanProfile: validated.scanProfile }) }),
    });
  },
  verifyTarget: (organizationId: string, applicationId: string, targetId: string) => {
    const input = customerTargetSchema.pick({ organizationId: true, applicationId: true, id: true }).parse({ organizationId, applicationId, id: targetId });
    return request(`${applicationPath(input.organizationId, input.applicationId)}/targets/${encodeURIComponent(input.id)}/verify`, customerTargetSchema, { method: 'POST', ...jsonBody({}) });
  },
  revokeTarget: (organizationId: string, applicationId: string, targetId: string) => {
    const input = customerTargetSchema.pick({ organizationId: true, applicationId: true, id: true }).parse({ organizationId, applicationId, id: targetId });
    return request(`${applicationPath(input.organizationId, input.applicationId)}/targets/${encodeURIComponent(input.id)}/revoke`, customerTargetSchema, { method: 'POST', ...jsonBody({}) });
  },
  sources: (organizationId: string, applicationId: string) => request(`${applicationPath(organizationId, applicationId)}/sources`, sourceListSchema),
  uploadSource: (input: { organizationId: string; applicationId: string; snapshot: { revision: string; files: { path: string; content: string }[] }; authorized: true }) => {
    const validated = customerUploadSourceSchema.parse(input);
    return request(`${applicationPath(validated.organizationId, validated.applicationId)}/sources`, customerSourceSummarySchema, {
      method: 'POST', ...jsonBody({ snapshot: validated.snapshot, authorized: validated.authorized }),
    });
  },
  deleteSource: (organizationId: string, applicationId: string, sourceId: string) => {
    const input = customerSourceSummarySchema.pick({ organizationId: true, applicationId: true, id: true }).parse({ organizationId, applicationId, id: sourceId });
    return request(`${applicationPath(input.organizationId, input.applicationId)}/sources/${encodeURIComponent(input.id)}`, deletedSourceSchema, { method: 'DELETE' });
  },
  reports: (organizationId: string, applicationId: string) => request(`${applicationPath(organizationId, applicationId)}/reports`, reportListSchema),
  report: (organizationId: string, applicationId: string, reportId: string) => request(`${applicationPath(organizationId, applicationId)}/reports/${encodeURIComponent(reportId)}`, customerAssessmentReportSchema),
  async reportRecommendations(organizationId: string, applicationId: string, reportId: string) {
    const params = reportRecommendationsParamsSchema.parse({ reportId });
    const recommendations = await request(
      `${applicationPath(organizationId, applicationId)}/reports/${encodeURIComponent(params.reportId)}/recommendations`,
      reportRecommendationsResponseSchema,
    );
    if (recommendations.scope.organizationId !== organizationId || recommendations.scope.applicationId !== applicationId || recommendations.scope.reportId !== params.reportId) {
      throw new CustomerApiError(200, 'invalid_response', 'El servidor devolvió recomendaciones para otro informe o aplicación.');
    }
    return recommendations;
  },
  prepareCorrection(input: { organizationId: string; applicationId: string; reportId: string; request: PrepareCorrectionRequest }) {
    const params = reportRecommendationsParamsSchema.parse({ reportId: input.reportId });
    const body = prepareCorrectionRequestSchema.parse(input.request);
    return request(
      `${applicationPath(input.organizationId, input.applicationId)}/reports/${encodeURIComponent(params.reportId)}/corrections`,
      prepareCorrectionResponseSchema,
      { method: 'POST', ...jsonBody(body) },
      201,
    );
  },
  actionProposals(organizationId: string, applicationId: string) {
    return request(`${applicationPath(organizationId, applicationId)}/actions`, actionListSchema);
  },
  proposeCorrectionAction(input: { organizationId: string; applicationId: string; candidateId: string }) {
    return request(`${applicationPath(input.organizationId, input.applicationId)}/actions`, z.object({ proposalId: z.uuid(), actionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), { method: 'POST', ...jsonBody({ kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId: input.candidateId } }) }, 201);
  },
  getActionEligibility(organizationId: string, applicationId: string, proposalId: string) {
    return request(`${applicationPath(organizationId, applicationId)}/actions/${encodeURIComponent(proposalId)}/eligibility`, actionEligibilitySchema, { method: 'POST', ...jsonBody({}) });
  },
  approveAction(input: { organizationId: string; applicationId: string; proposalId: string; actionHash: string; stepUpProof: string }) {
    return request(`${applicationPath(input.organizationId, input.applicationId)}/actions/${encodeURIComponent(input.proposalId)}/approve`, z.object({ approvalId: z.uuid(), expiresAt: z.iso.datetime() }).strict(), { method: 'POST', ...jsonBody({ proposalId: input.proposalId, actionHash: input.actionHash, stepUpProof: input.stepUpProof }) });
  },
  cancelAction(input: { organizationId: string; applicationId: string; proposalId: string; reject?: boolean }) {
    const suffix = input.reject ? 'reject' : 'cancel';
    return request(`${applicationPath(input.organizationId, input.applicationId)}/actions/${encodeURIComponent(input.proposalId)}/${suffix}`, z.object({ accepted: z.literal(true) }).strict(), { method: 'POST', ...jsonBody({}) }, 202);
  },
  queue: (input: { organizationId: string; applicationId: string; mode: AssessmentMode; sourceSnapshotId: string | null; targetId: string | null }) => {
    const { organizationId, applicationId, ...selection } = input;
    const validated = customerQueueSchema.parse({ ...input, idempotencyKey: crypto.randomUUID() });
    const idempotencyKey = validated.idempotencyKey;
    return request(`${applicationPath(organizationId, applicationId)}/assessments`, queuedAssessmentSchema, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(selection),
    });
  },
  job: (organizationId: string, applicationId: string, jobId: string) => request(`${organizationPath(organizationId)}/jobs/${encodeURIComponent(jobId)}`, customerJobSchema),
  githubConnect: async (organizationId: string) => {
    const result = await request('/api/customer/github/connect', z.object({ installUrl: z.string().url() }).strict(), { method: 'POST', ...jsonBody({ organizationId }) });
    return result.installUrl;
  },
  githubConnections: (organizationId: string) => request(`${organizationPath(organizationId)}/github/connections`, z.array(githubConnectionSchema).max(20)),
  githubRepositories: (organizationId: string, applicationId: string, installationId: string) => request(`${applicationPath(organizationId, applicationId)}/github/installations/${encodeURIComponent(installationId)}/repositories`, z.array(githubRepositorySchema).max(1000)),
  githubSelectRepository: (input: { organizationId: string; applicationId: string; installationId: string; repositoryId: number; fullName: string; defaultBranch: string }) => request(
    `${applicationPath(input.organizationId, input.applicationId)}/github/installations/${encodeURIComponent(input.installationId)}/repositories/${input.repositoryId}/select`,
    githubSelectSchema, { method: 'POST', ...jsonBody({ fullName: input.fullName, defaultBranch: input.defaultBranch }) }, 201,
  ),
  githubDisconnect: (organizationId: string, installationId: string) => request(`${organizationPath(organizationId)}/github/connections/${encodeURIComponent(installationId)}`, z.undefined(), { method: 'DELETE' }),
};
export { request as customerRequest };
