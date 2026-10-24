import {
  customerApplicationSchema,
  customerAssessmentReportSchema,
  customerCreateApplicationSchema,
  customerCreateWorkspaceSchema,
  customerEnrollTargetSchema,
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
} from '@gotchu/contracts';
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

export type CustomerSession = z.infer<typeof customerSessionSchema>;
export type CustomerJob = z.infer<typeof customerJobSchema>;

export class CustomerApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CustomerApiError';
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
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
    return customerApi.session();
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
  enrollTarget: (input: { organizationId: string; applicationId: string; origin: string; authorized: true }) => {
    const { organizationId, applicationId, origin, authorized } = input;
    const validated = customerEnrollTargetSchema.parse({ organizationId, applicationId, origin, authorized });
    return request(`${applicationPath(organizationId, applicationId)}/targets`, customerEnrollmentSchema, {
      method: 'POST', ...jsonBody({ origin: validated.origin, authorized: validated.authorized }),
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
  queue: (input: { organizationId: string; applicationId: string; mode: AssessmentMode; sourceSnapshotId: string | null; targetId: string | null }) => {
    const { organizationId, applicationId, ...selection } = input;
    const validated = customerQueueSchema.parse({ ...input, idempotencyKey: crypto.randomUUID() });
    const idempotencyKey = validated.idempotencyKey;
    return request(`${applicationPath(organizationId, applicationId)}/assessments`, queuedAssessmentSchema, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(selection),
    });
  },
  job: (organizationId: string, applicationId: string, jobId: string) => request(`${organizationPath(organizationId)}/jobs/${encodeURIComponent(jobId)}`, customerJobSchema),
};
