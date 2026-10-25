import { apiOperationSchema, type ApiOperation } from '@gotchu/contracts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deliberately narrower than URL syntax; schema data never supplies query values or destinations. */
export function apiProbePath(value: string) {
  return value.length <= 160 && /^\/(?:[a-zA-Z0-9_~.-]+\/)*[a-zA-Z0-9_~.-]*$/.test(value)
    && !value.split('/').some(part => part === '.' || part === '..');
}

function authentication(operation: Record<string, unknown>, document: Record<string, unknown>): ApiOperation['authentication'] {
  const security = Object.hasOwn(operation, 'security') ? operation.security : document.security;
  if (security === undefined) return 'not_declared';
  if (!Array.isArray(security) || security.length > 20 || security.some(item => !record(item))) return 'unknown';
  if (security.length === 0 || security.some(item => record(item) && Object.keys(item).length === 0)) return 'not_declared';
  return security.every(item => record(item) && Object.values(item).every(value => Array.isArray(value) && value.every(scope => typeof scope === 'string')))
    ? 'declared' : 'unknown';
}

function rootMapping(document: Record<string, unknown>, origin: string, swagger: boolean) {
  if (swagger) return (document.basePath === undefined || document.basePath === '/')
    && (document.host === undefined || document.host === new URL(origin).host)
    && (document.schemes === undefined || Array.isArray(document.schemes) && document.schemes.length === 1 && document.schemes[0] === 'https');
  if (document.servers === undefined) return true;
  if (!Array.isArray(document.servers) || document.servers.length !== 1) return false;
  const server = document.servers[0];
  return record(server) && (server.url === '/' || server.url === origin || server.url === `${origin}/`);
}

export interface ApiSchemaInventory {
  operations: ApiOperation[];
  documentedOperationCount: number;
  truncated: boolean;
}

function supportedOperation(operation: Record<string, unknown>) {
  if (!record(operation.responses) || Object.keys(operation.responses).length === 0) return false;
  return Object.entries(operation.responses).every(([code, response]) =>
    (code === 'default' || /^[1-5](?:\d{2}|XX)$/.test(code)) && record(response)
      && !('$ref' in response) && typeof response.description === 'string');
}

/** Inert JSON only. No refs, examples, scripts, callbacks, servers or descriptions are executed/read remotely. */
export function inspectApiSchema(body: string, origin: string): ApiSchemaInventory | null {
  let document: unknown;
  try { document = JSON.parse(body); } catch { return null; }
  if (!record(document)) return null;
  const swagger = document.swagger === '2.0';
  if (!swagger && !(typeof document.openapi === 'string' && /^3\.[01]\.\d+$/.test(document.openapi))) return null;
  if (!record(document.info) || typeof document.info.title !== 'string' || typeof document.info.version !== 'string') return null;
  if (!record(document.paths)) return null;
  const operations: ApiOperation[] = [];
  let documentedOperationCount = 0;
  let truncated = false;
  const mapped = rootMapping(document, origin, swagger);
  let pathsSeen = 0;
  for (const [path, item] of Object.entries(document.paths)) {
    if (++pathsSeen > 100) { truncated = true; break; }
    if (!record(item)) { truncated = true; continue; }
    if ('$ref' in item) truncated = true;
    for (const method of apiOperationSchema.shape.method.options) {
      const operation = item[method.toLowerCase()];
      if (operation === undefined) continue;
      documentedOperationCount++;
      if (!record(operation) || '$ref' in operation || !supportedOperation(operation) || !apiProbePath(path)) { truncated = true; continue; }
      // Parameterized operations and alternate server mappings cannot be exercised accurately here.
      const auth = authentication(operation, document);
      if (auth === 'unknown') truncated = true;
      const eligible = mapped && auth !== 'unknown' && !('$ref' in item) && !('servers' in item) && !('servers' in operation)
        && !('parameters' in item) && !('parameters' in operation) && method === 'GET';
      if (operations.length < 8) operations.push({ path, method, authentication: auth, probeEligible: eligible });
      else truncated = true;
    }
  }
  return { operations, documentedOperationCount, truncated };
}
