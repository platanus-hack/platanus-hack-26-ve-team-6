import { assessmentQueuedSchema, assessmentReportSchema, assessmentRequestSchema, demoAssessmentJobSchema, demoWorkspaceSchema, type AssessmentRequest } from '@gotchu/contracts';
import { DEMO_ASSESSMENT_SCOPE, DEMO_ASSESSMENT_TARGET_KEY, type Backend } from '@gotchu/backend';
import { z } from 'zod';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';

export interface DemoAssessmentServices {
  target(): ReturnType<Backend['assessments']['getTarget']>;
  reports(): ReturnType<Backend['assessments']['list']>;
  queue(request: AssessmentRequest, idempotencyKey: string): ReturnType<Backend['assessments']['queue']>;
  report(reportId: string): ReturnType<Backend['assessments']['get']>;
  job(jobId: string): ReturnType<Backend['web']['getJob']>;
}

export function bindDemoAssessmentServices(backend: Backend): DemoAssessmentServices {
  const { organizationId, applicationId, userId } = DEMO_ASSESSMENT_SCOPE;
  const scope = { organizationId, applicationId };
  const identity = { userId };
  return {
    target: () => backend.assessments.getTarget(identity, scope),
    reports: () => backend.assessments.list(identity, { ...scope, limit: 20 }),
    queue: (request, idempotencyKey) => backend.assessments.queue(identity, { ...scope, ...request, idempotencyKey }),
    report: (reportId) => backend.assessments.get(identity, { ...scope, reportId }),
    job: (jobId) => backend.web.getJob(identity, { organizationId, jobId }),
  };
}

/** Public access is limited to an explicitly enabled, fixed, operator-seeded demo. */
export function createDemoAssessmentApi(options: { enabled: boolean; origin: string; services: DemoAssessmentServices | null; clock?: () => number }) {
  const recent = new Map<string, { request: string; at: number }>();
  const clock = options.clock ?? Date.now;
  let windowStart = clock();
  let requestCount = 0;
  return async (request: Request): Promise<Response> => {
    try {
      if (!options.enabled) throw new HttpError(503, 'demo_not_enabled', 'La demostración controlada no está habilitada.');
      const services = options.services;
      if (!services) throw new HttpError(503, 'demo_not_configured', 'La demostración necesita su base de datos y configuración inicial.');
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/demo/workspace') {
        const [target, reports] = await Promise.all([services.target(), services.reports()]);
        return json(demoWorkspaceSchema.parse({
          kind: 'controlled_demo', application: { id: DEMO_ASSESSMENT_SCOPE.applicationId, name: 'Tienda de demostración' },
          targetConfigured: target?.targetKey === DEMO_ASSESSMENT_TARGET_KEY,
          reports: reports.map((report) => ({ id: report.id, mode: report.mode, revision: report.revision, createdAt: report.finishedAt })),
          responseMode: 'observation', providerRequired: false,
        }));
      }
      if (request.method === 'POST' && path === '/api/demo/assessments') {
        requireSameOrigin(request, options.origin);
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
        const key = z.uuid().safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new HttpError(400, 'idempotency_required', 'Se necesita un identificador de solicitud válido.');
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 1_024))); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_input', 'La solicitud no contiene JSON válido.'); }
        const input = assessmentRequestSchema.safeParse(payload);
        if (!input.success) throw new HttpError(400, 'invalid_input', 'Sólo puedes elegir el tipo de análisis y la versión de la demo.');
        const now = clock();
        if (now - windowStart >= 60_000) { windowStart = now; requestCount = 0; }
        if (requestCount >= 30) return json({ error: { code: 'demo_rate_limit', message: 'Demasiadas solicitudes para esta demo. Inténtalo más tarde.' } }, 429, { 'Retry-After': '60' });
        requestCount++;
        for (const [id, entry] of recent) if (entry.at <= now - 60_000) recent.delete(id);
        const serialized = JSON.stringify(input.data);
        const prior = recent.get(key.data);
        if (prior && prior.request !== serialized) throw new HttpError(409, 'idempotency_conflict', 'El identificador ya pertenece a otra solicitud.');
        if (!prior && recent.size >= 10) return json({ error: { code: 'demo_rate_limit', message: 'La demo ha alcanzado su límite temporal. Inténtalo más tarde.' } }, 429, { 'Retry-After': '60' });
        if (!prior) recent.set(key.data, { at: now, request: serialized });
        const target = await services.target();
        if (target?.targetKey !== DEMO_ASSESSMENT_TARGET_KEY) throw new HttpError(409, 'demo_target_not_configured', 'El objetivo de demostración no está preparado.');
        return json(assessmentQueuedSchema.parse(await services.queue(input.data, key.data)), 202);
      }
      const report = /^\/api\/demo\/reports\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && report) {
        const id = z.uuid().safeParse(report[1]);
        if (!id.success) throw new HttpError(400, 'invalid_input', 'Identificador de informe inválido.');
        const value = assessmentReportSchema.parse(await services.report(id.data));
        if (value.organizationId !== DEMO_ASSESSMENT_SCOPE.organizationId || value.applicationId !== DEMO_ASSESSMENT_SCOPE.applicationId) throw new HttpError(404, 'not_found', 'Informe no encontrado.');
        return json(value);
      }
      const job = /^\/api\/demo\/jobs\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && job) {
        const id = z.uuid().safeParse(job[1]);
        if (!id.success) throw new HttpError(400, 'invalid_input', 'Identificador de trabajo inválido.');
        const value = await services.job(id.data);
        if (value.applicationId !== DEMO_ASSESSMENT_SCOPE.applicationId || value.kind !== 'audit') throw new HttpError(404, 'not_found', 'Trabajo no encontrado.');
        return json(demoAssessmentJobSchema.parse({ id: value.id, state: value.state, reportId: value.reportId, reasonCode: value.reasonCode }));
      }
      throw new HttpError(404, 'not_found', 'No existe esta operación de demostración.');
    } catch (error) { return errorResponse(error); }
  };
}
