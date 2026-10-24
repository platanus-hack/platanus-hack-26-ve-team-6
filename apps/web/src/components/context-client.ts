import {
  contextInventorySchema, createEnvironmentSchema, createRepositoryLinkSchema, createServiceSchema,
  revokeRepositoryLinkSchema, updateEnvironmentSchema, type ContextInventory,
} from '@gotchu/contracts';
import { z } from 'zod';

const repositoryOptionsSchema = z.array(z.object({ key: z.string().max(128), label: z.string().max(200) }).strict()).max(100);
async function call<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let payload: unknown;
  try { payload = response.status === 204 ? undefined : await response.json(); } catch { throw new Error('El servidor devolvió una respuesta que no se pudo leer.'); }
  if (!response.ok) {
    if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'object' && payload.error !== null && 'message' in payload.error && typeof payload.error.message === 'string') throw new Error(payload.error.message);
    throw new Error('No se pudo actualizar el inventario de contexto.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error('El servidor devolvió datos que no coinciden con el contrato esperado.');
  return parsed.data;
}
const root = (organizationId: string, applicationId: string) => `/api/customer/workspaces/${encodeURIComponent(organizationId)}/applications/${encodeURIComponent(applicationId)}/context`;
export const contextClient = {
  list(organizationId: string, applicationId: string) { return call(root(organizationId, applicationId), contextInventorySchema); },
  repositoryOptions(organizationId: string, applicationId: string) { return call(`/api/customer/workspaces/${encodeURIComponent(organizationId)}/applications/${encodeURIComponent(applicationId)}/repositories`, repositoryOptionsSchema); },
  createEnvironment(input: z.input<typeof createEnvironmentSchema>) { return call(`${root(input.organizationId, input.applicationId)}/environments`, contextInventorySchema.shape.environments.element, 'POST', { name: input.name, kind: input.kind }); },
  updateEnvironment(input: z.input<typeof updateEnvironmentSchema>) { return call(`${root(input.organizationId, input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}`, contextInventorySchema.shape.environments.element, 'PATCH', { ...(input.name === undefined ? {} : { name: input.name }), ...(input.kind === undefined ? {} : { kind: input.kind }) }); },
  archiveEnvironment(input: { organizationId: string; applicationId: string; environmentId: string }) { return call(`${root(input.organizationId, input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/archive`, contextInventorySchema.shape.environments.element, 'POST', {}); },
  createService(input: z.input<typeof createServiceSchema>) { return call(`${root(input.organizationId, input.applicationId)}/services`, contextInventorySchema.shape.services.element, 'POST', { environmentId: input.environmentId, name: input.name, kind: input.kind }); },
  createRepositoryLink(input: z.input<typeof createRepositoryLinkSchema>) { return call(`${root(input.organizationId, input.applicationId)}/repositories`, contextInventorySchema.shape.repositoryLinks.element, 'POST', { repositoryKey: input.repositoryKey, subdirectory: input.subdirectory, defaultBranch: input.defaultBranch }); },
  revokeRepositoryLink(input: z.input<typeof revokeRepositoryLinkSchema>) { return call(`${root(input.organizationId, input.applicationId)}/repositories/${encodeURIComponent(input.repositoryLinkId)}/revoke`, contextInventorySchema.shape.repositoryLinks.element, 'POST', {}); },
};
export type { ContextInventory };
