import { describe, expect, it, vi } from 'vitest';
import { mcpToolInputSchemas } from '@gotchu/contracts';
import { BackendError, type McpPrincipal } from '@gotchu/backend';
import { createMcpHandler } from '../src/server/mcp.js';
import type { McpToolServices } from '../src/server/mcp-tools.js';

const origin = 'https://gotchu.test';
const principal: McpPrincipal = { identity: { userId: 'member' }, organizationId: '10000000-0000-4000-8000-000000000001', tokenId: '20000000-0000-4000-8000-000000000002' };
const applicationId = '30000000-0000-4000-8000-000000000003';
const token = 'gmcp.valid';
const modern = '2026-07-28';

const unused = async (): Promise<never> => { throw new Error('not used by this test'); };
function services() {
  return {
    customers: {
      listApplications: vi.fn(async () => [{ organizationId: principal.organizationId, applicationId, name: 'Tienda', archived: false, createdAt: '2026-10-24T00:00:00.000Z' }]),
      listReports: unused,
      getReport: vi.fn(async (): Promise<never> => { throw new BackendError('not_found', 'Report not found', 404); }),
    },
    operations: { getCoverage: unused, listAlerts: unused },
  } satisfies McpToolServices;
}

function handler(svc = services()) {
  return createMcpHandler({ origin, services: svc, requestsPerMinute: 5,
    authenticate: async bearer => { if (bearer !== token) throw new BackendError('mcp_token_invalid', 'invalid', 401); return principal; } });
}

function rpc(method: string, params: Record<string, unknown> = {}, options: { version?: string | null; headers?: Record<string, string>; bearer?: string | null; id?: number | null } = {}) {
  const version = options.version === undefined ? modern : options.version;
  const body = { jsonrpc: '2.0', ...(options.id === null ? {} : { id: options.id ?? 1 }), method,
    params: version ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : params };
  return new Request(`${origin}/api/mcp`, { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(options.bearer === null ? {} : { authorization: `Bearer ${options.bearer ?? token}` }),
    ...(version ? { 'mcp-protocol-version': version, 'mcp-method': method } : {}),
    ...(method === 'tools/call' && version && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    ...options.headers } });
}

describe('Gotchu MCP endpoint', () => {
  it('requires a valid bearer token and rejects foreign browser origins', async () => {
    const handle = handler();
    for (const bearer of [null, 'gmcp.revoked']) {
      const response = await handle(rpc('tools/list', {}, { bearer }));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
    }
    expect((await handle(rpc('tools/list', {}, { headers: { origin: 'https://evil.test' } }))).status).toBe(403);
    expect((await handle(new Request(`${origin}/api/mcp`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }))).status).toBe(405);
  });

  it('serves modern per-request metadata and validates the mirrored headers', async () => {
    const handle = handler();
    const discover = await handle(rpc('server/discover'));
    expect(await discover.json()).toMatchObject({ result: { resultType: 'complete', supportedVersions: expect.arrayContaining([modern, '2025-11-25']), capabilities: { tools: {} } } });
    const unsupported = await handle(rpc('tools/list', {}, { version: '1900-01-01' }));
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: -32022, data: { requested: '1900-01-01' } } });
    const mismatch = await handle(rpc('tools/list', {}, { headers: { 'mcp-method': 'tools/call' } }));
    expect(await mismatch.json()).toMatchObject({ error: { code: -32020 } });
    const wrongName = await handle(rpc('tools/call', { name: 'list_applications', arguments: {} }, { headers: { 'mcp-name': 'list_reports' } }));
    expect(await wrongName.json()).toMatchObject({ error: { code: -32020 } });
    const unknown = await handle(rpc('resources/list'));
    expect(unknown.status).toBe(404);
  });

  it('still answers legacy initialize-based clients without sessions', async () => {
    const handle = handler();
    const init = await handle(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }, { version: null }));
    expect(await init.json()).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'gotchu' } } });
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect((await handle(rpc('notifications/initialized', {}, { version: null, id: null }))).status).toBe(202);
    const list = await handle(rpc('tools/list', {}, { version: null, headers: { 'mcp-protocol-version': '2025-06-18' } }));
    expect(await list.json()).toMatchObject({ result: { tools: expect.any(Array) } });
  });

  it('lists every contract tool, all read-only', async () => {
    const response = await handler()(rpc('tools/list'));
    const { result } = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> }; annotations: { readOnlyHint: boolean } }> } };
    expect(result.tools.map(tool => tool.name)).toEqual(Object.keys(mcpToolInputSchemas));
    expect(result.tools.every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(result.tools.map(tool => tool.name).join(' ')).not.toMatch(/request|queue|run|approve|merge|pull|deploy|acknowledge/);
    for (const tool of result.tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('organizationId');
  });

  it('scopes calls to the token workspace and reports domain failures as tool errors', async () => {
    const svc = services();
    const handle = handler(svc);
    const listed = await handle(rpc('tools/call', { name: 'list_applications', arguments: {} }));
    expect(await listed.json()).toMatchObject({ result: { resultType: 'complete', isError: false, structuredContent: { applications: [{ applicationId, name: 'Tienda' }] } } });
    expect(svc.customers.listApplications).toHaveBeenCalledExactlyOnceWith(principal.identity, { organizationId: principal.organizationId });

    const smuggled = await handle(rpc('tools/call', { name: 'list_applications', arguments: { organizationId: '90000000-0000-4000-8000-000000000009' } }));
    expect(await smuggled.json()).toMatchObject({ result: { isError: true } });

    const reportId = '50000000-0000-4000-8000-000000000005';
    const missing = await handle(rpc('tools/call', { name: 'get_finding_prompt', arguments: { applicationId, reportId, findingId: '60000000-0000-4000-8000-000000000006' } }));
    expect(await missing.json()).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('not_found') }] } });
    expect(svc.customers.getReport).toHaveBeenCalledExactlyOnceWith(principal.identity, { organizationId: principal.organizationId, applicationId, reportId });
  });

  it('rate-limits each token', async () => {
    const handle = handler();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await handle(rpc('ping'))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
