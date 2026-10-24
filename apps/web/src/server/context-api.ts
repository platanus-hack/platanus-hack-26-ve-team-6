import { z } from 'zod';
import {
  contextInventorySchema, contextScopeSchema, createDependencyRelationSchema, createDeploymentSchema,
  createEnvironmentSchema, createOriginCandidateSchema, createRepositoryLinkSchema, createServiceSchema,
  updateEnvironmentSchema, updateServiceSchema, archiveEnvironmentSchema, revokeRepositoryLinkSchema,
  environmentSchema, serviceSchema, repositoryLinkSchema, deploymentSchema, dependencyRelationSchema,
  originCandidateSchema,
} from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { errorResponse, HttpError, json, readBoundedBody } from './http.js';

export type ContextApiService = Backend['context'];
const uuid = z.uuid();
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 16_384))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return result.data;
}
export async function handleContextApi(request: Request, identity: Identity, service: ContextApiService, repositoryCatalog?: (identity: Identity, scope: z.infer<typeof contextScopeSchema>) => Promise<Array<{ key: string; label: string }>>): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'customer' || parts[2] !== 'workspaces' || parts[4] !== 'applications' || parts[6] !== 'context') return null;
  try {
    const scope = parse(contextScopeSchema, { organizationId: parts[3], applicationId: parts[5] });
    const resource = parts[7];
    if (!resource && request.method === 'GET') return json(contextInventorySchema.parse(await service.list(identity, scope)));
    if (resource === 'environments' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createEnvironmentSchema.omit({ organizationId: true, applicationId: true, observedAt: true }), await readBody(request));
      return json(environmentSchema.parse(await service.createEnvironment(identity, { ...scope, ...input, observedAt: new Date().toISOString() })), 201);
    }
    if (resource === 'environments' && parts.length === 10) {
      const environmentId = parse(uuid, parts[8]);
      if (request.method === 'PATCH') {
        const input = parse(updateEnvironmentSchema.omit({ organizationId: true, applicationId: true, environmentId: true }), await readBody(request));
        return json(environmentSchema.parse(await service.updateEnvironment(identity, { ...scope, environmentId, ...input })));
      }
      if (request.method === 'POST' && parts[9] === 'archive') {
        parse(z.object({}).strict(), await readBody(request));
        return json(environmentSchema.parse(await service.archiveEnvironment(identity, { ...scope, environmentId, archived: true })));
      }
    }
    if (resource === 'services' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createServiceSchema.omit({ organizationId: true, applicationId: true, observedAt: true }), await readBody(request));
      return json(serviceSchema.parse(await service.createService(identity, { ...scope, ...input, observedAt: new Date().toISOString() })), 201);
    }
    if (resource === 'services' && parts.length === 9 && request.method === 'PATCH') {
      const serviceId = parse(uuid, parts[8]);
      const input = parse(updateServiceSchema.omit({ organizationId: true, applicationId: true, serviceId: true }), await readBody(request));
      return json(serviceSchema.parse(await service.updateService(identity, { ...scope, serviceId, ...input })));
    }
    if (resource === 'repositories' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createRepositoryLinkSchema.omit({ organizationId: true, applicationId: true }), await readBody(request));
      const allowedRepositories = await repositoryCatalog?.(identity, scope) ?? [];
      if (!allowedRepositories.some(repository => repository.key === input.repositoryKey)) throw new HttpError(404, 'repository_not_in_catalog', 'El repositorio no está en el catálogo autorizado.');
      return json(repositoryLinkSchema.parse(await service.createRepositoryLink(identity, { ...scope, ...input })), 201);
    }
    if (resource === 'repositories' && parts.length === 10 && parts[9] === 'revoke' && request.method === 'POST') {
      parse(z.object({}).strict(), await readBody(request));
      return json(repositoryLinkSchema.parse(await service.revokeRepositoryLink(identity, { ...scope, repositoryLinkId: parse(uuid, parts[8]) })));
    }
    if (resource === 'deployments' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createDeploymentSchema.omit({ organizationId: true, applicationId: true }), await readBody(request));
      return json(deploymentSchema.parse(await service.createDeployment(identity, { ...scope, ...input })), 201);
    }
    if (resource === 'dependencies' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createDependencyRelationSchema.omit({ organizationId: true, applicationId: true, observedAt: true }), await readBody(request));
      return json(dependencyRelationSchema.parse(await service.createDependency(identity, { ...scope, ...input, observedAt: new Date().toISOString() })), 201);
    }
    if (resource === 'origins' && parts.length === 8 && request.method === 'POST') {
      const input = parse(createOriginCandidateSchema.omit({ organizationId: true, applicationId: true, observedAt: true }), await readBody(request));
      return json(originCandidateSchema.parse(await service.createOriginCandidate(identity, { ...scope, ...input, observedAt: new Date().toISOString() })), 201);
    }
    throw new HttpError(404, 'not_found', 'Ruta de contexto no encontrada.');
  } catch (error) { return errorResponse(error); }
}
