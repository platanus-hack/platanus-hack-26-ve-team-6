import { assessmentQueuedSchema, assessmentReportSchema, demoAssessmentJobSchema, demoWorkspaceSchema, type AssessmentRequest } from '@gotchu/contracts';
import { z } from 'zod';

export class AssessmentApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.safeParse(payload);
    throw new AssessmentApiError(response.status, error.success ? error.data.error.code : 'request_failed', error.success ? error.data.error.message : 'No se pudo completar la solicitud.');
  }
  return schema.parse(payload);
}
export const loadWorkspace = () => request('/api/demo/workspace', demoWorkspaceSchema);
export const loadReport = (id: string) => request(`/api/demo/reports/${encodeURIComponent(id)}`, assessmentReportSchema);
export const loadJob = (id: string) => request(`/api/demo/jobs/${encodeURIComponent(id)}`, demoAssessmentJobSchema);
export const queueAssessment = (input: AssessmentRequest) => request('/api/demo/assessments', assessmentQueuedSchema, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(input),
});
