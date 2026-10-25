import {
  API_CHECKS_MAX_REQUESTS, API_CHECKS_MAX_RESPONSE_BYTES, API_CHECKS_VERSION,
  apiCheckEvidenceSchema, apiScenarioIdSchema, customerRunInputSchema,
  type ApiCheckEvidence, type ApiOperation,
} from '@gotchu/contracts';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { analysis, evidence, finish, sha256 } from './common.js';
import { API_PROBE_ORIGIN, createHttpsApiProbe, type ApiProbeKind, type HttpsOptions, type HttpsPageObservation } from './https.js';
import { inspectApiSchema } from './api-schema.js';
import { addApiFindings } from './api-findings.js';

const targetSchema = customerRunInputSchema.shape.target.unwrap().extend({ scanProfile: z.literal('api_checks') });
type ApiTarget = z.infer<typeof targetSchema>;
const schemaPaths = ['/openapi.json', '/swagger.json', '/api/openapi.json', '/api/swagger.json', '/v3/api-docs'];
const methods: Record<ApiProbeKind, ApiCheckEvidence['method']> = { observe: 'GET', schema: 'GET', head: 'HEAD', cors: 'HEAD', preflight: 'OPTIONS', options: 'OPTIONS' };
const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

function signals(page: HttpsPageObservation, scenario: ApiCheckEvidence['scenarioId']): ApiCheckEvidence['signals'] {
  const result: ApiCheckEvidence['signals'] = {};
  if (scenario === 'cors_preflight') {
    const origin = page.headers['access-control-allow-origin'];
    result.originAllowed = origin === API_PROBE_ORIGIN ? 'probe_origin' : origin === '*' ? 'wildcard' : origin ? 'other' : 'absent';
    result.credentialsAllowed = page.headers['access-control-allow-credentials'] === 'true';
    result.authorizationAllowed = (page.headers['access-control-allow-headers'] ?? '').split(',').some(value => value.trim().toLowerCase() === 'authorization');
  }
  if (scenario === 'method_policy' || scenario === 'cors_preflight') {
    const tokens = (page.headers[scenario === 'method_policy' ? 'allow' : 'access-control-allow-methods'] ?? '').split(',').map(value => value.trim());
    result.allowedMethods = allowedMethods.filter(method => tokens.includes(method));
  }
  if (scenario === 'error_handling' && page.incomplete === null && page.status >= 400) {
    if (/(?:Traceback \(most recent call last\)|\n\s+at [\w.$<>]+ \([^\n]{1,200}:\d+:\d+\))/.test(page.body)) result.errorSignature = 'stack_trace';
    else if (/(?:SQLSTATE\[[A-Z0-9]{5}\]|You have an error in your SQL syntax)/.test(page.body)) result.errorSignature = 'database_error';
  }
  return result;
}

export async function assessApiChecks(raw: ApiTarget, signal: AbortSignal, options: HttpsOptions = {}) {
  const target = targetSchema.parse(raw);
  const a = analysis('external', `target:${target.id}:${target.version}:${sha256(target.origin)}:api_checks`);
  const probe = createHttpsApiProbe(options);
  const observations: ApiCheckEvidence[] = [];
  const operations: ApiOperation[] = [];
  let attempts = 0; let responseBytes = 0; let stopped: string | null = null;

  const run = async (scenarioId: ApiCheckEvidence['scenarioId'], path: string, kind: ApiProbeKind, maxBytes = 16_384) => {
    const item: ApiCheckEvidence = { profile: 'api_checks', catalogVersion: API_CHECKS_VERSION, scenarioId,
      path, method: methods[kind], status: null, tlsVerified: false, headers: {}, bodyBytes: 0, incomplete: null, signals: {} };
    if (attempts > 0 && !stopped) {
      try { await delay(250, undefined, { signal }); } catch { stopped = 'deadline_exceeded'; }
    }
    if (signal.aborted) stopped = 'deadline_exceeded';
    if (Date.parse(target.authorizedAt) > Date.now() || Date.parse(target.expiresAt) <= Date.now()) stopped = 'scope_expired';
    if (attempts >= API_CHECKS_MAX_REQUESTS) stopped = 'request_cap';
    if (responseBytes >= API_CHECKS_MAX_RESPONSE_BYTES) stopped = 'response_byte_cap';
    if (stopped) { item.incomplete = stopped; observations.push(item); return; }
    attempts++;
    let page: HttpsPageObservation;
    try { page = await probe(target.origin, path, kind, signal, target.expiresAt, Math.min(maxBytes, API_CHECKS_MAX_RESPONSE_BYTES - responseBytes)); }
    catch (error) { item.incomplete = signal.aborted ? 'deadline_exceeded' : error instanceof Error && error.message === 'invalid_http_status' ? 'invalid_http_status' : 'transport_unavailable'; observations.push(item); return; }
    responseBytes += page.bodyBytes;
    Object.assign(item, { status: page.status, tlsVerified: page.tlsVerified, bodyBytes: page.bodyBytes, incomplete: page.incomplete, bodyPolicy: page.bodyPolicy ?? 'bounded_body', signals: signals(page, scenarioId) });
    // API evidence retains a normalized MIME category, never arbitrary header values or body text.
    const mime = (page.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (mime && ['application/json', 'text/html', 'text/plain', 'application/problem+json'].includes(mime)) item.headers['content-type'] = mime;
    if (scenarioId === 'schema_discovery') {
      const inventory = page.status === 200 && page.incomplete === null && /^(?:application\/(?:json|[\w.-]+\+json))$/i.test(mime ?? '')
        ? inspectApiSchema(page.body, target.origin) : null;
      item.signals.schema = inventory !== null;
      if (inventory) {
        item.signals.documentedOperationCount = inventory.documentedOperationCount;
        item.signals.operationsTruncated = inventory.truncated;
        item.signals.operations = inventory.operations;
        for (const operation of inventory.operations) if (!operations.some(prior => prior.path === operation.path && prior.method === operation.method)) operations.push(operation);
      }
    }
    observations.push(item);
  };

  // Reserve protocol checks before schema discovery can spend the body budget.
  await run('cors_preflight', '/', 'cors');
  await run('cors_preflight', '/', 'preflight');
  await run('method_policy', '/', 'options');
  await run('error_handling', '/.well-known/gotchu-api-check-v1-missing', 'observe', 4096);
  for (const path of schemaPaths) {
    await run('schema_discovery', path, 'schema');
    if (operations.length > 0) break;
  }
  const paths = [...new Set(operations.filter(item => item.probeEligible).map(item => item.path))].slice(0, 2);
  // Without a schema, prefixes are protocol observations, never inferred endpoint inventory.
  for (const path of paths.length ? paths : ['/api', '/api/v1']) {
    await run('auth_boundary', path, 'head');
    await run('cors_preflight', path, 'cors');
    await run('cors_preflight', path, 'preflight');
  }

  const persisted = observations.map(item => {
    const parsed = apiCheckEvidenceSchema.parse(item);
    const id = evidence(a, item.status === null ? 'configuration' : 'http_response', `${target.origin}${item.path}`, parsed,
      { name: 'gotchu-api-checks', version: API_CHECKS_VERSION });
    return { item: parsed, id };
  });
  for (const { item, id } of persisted) addApiFindings(a, item, id, `${target.origin}${item.path}`, persisted);
  for (const scenario of apiScenarioIdSchema.options) {
    const items = observations.filter(item => item.scenarioId === scenario);
    const complete = items.length > 0 && items.every(item => item.tlsVerified && item.incomplete === null);
    const discovery = scenario === 'schema_discovery';
    const schema = items.find(item => item.signals.schema);
    a.coverage.push({ capability: `api_${scenario}`, state: complete && (!discovery || schema && !schema.signals.operationsTruncated) ? 'inspected' : 'unavailable',
      detail: discovery
        ? schema ? `Found an inert OpenAPI document with ${schema.signals.documentedOperationCount} declared operations; at most eight retained. Alternate servers, refs, templates and parameterized routes are not probed.` : 'No complete supported OpenAPI JSON document found in the fixed locations. API inventory remains unknown; a 200 HTML fallback is not an API schema.'
        : `${items.filter(item => item.status !== null).length}/${items.length} HTTP observations. HEAD/OPTIONS inspect response headers only; they do not prove GET access, method execution, or an authorization bypass. Incomplete or unattempted checks remain unknown.` });
  }
  a.coverage.push({ capability: 'api_endpoint_mapping', state: paths.length > 0 && paths.length === new Set(operations.map(item => item.path)).size && operations.every(item => item.probeEligible) ? 'inspected' : 'unavailable',
    detail: `${paths.length} literal documented GET paths selected for HEAD/OPTIONS sampling. Other methods, templates, parameters, alternate servers, unresolved refs, and unsampled paths remain unknown. No business GET response was requested.` });
  a.coverage.push({ capability: 'api_probe_budget', state: stopped ? 'unavailable' : 'inspected', detail: `${attempts}/${API_CHECKS_MAX_REQUESTS} serial request attempts; ${responseBytes}/${API_CHECKS_MAX_RESPONSE_BYTES} body bytes. ${stopped ? `Stopped: ${stopped}.` : 'No overall request/byte cap reached.'} Each connection revalidates DNS, pins a public address, verifies TLS and refuses redirects.` });
  a.coverage.push({ capability: 'api_exploitation', state: 'unsupported', detail: 'No CVE exploit execution, authenticated access, IDOR, injection, brute force, overload or customer-code execution. These require separate supported scenarios and appropriate isolated validation.' });
  a.limitations.push(
    'The requested scope records the signed-in user’s request, not domain ownership proof. The explicit api_checks profile applies to manual and enabled scheduled assessments with the same bounds.',
    'Versioned protocol scenarios run real GET/HEAD/OPTIONS requests: at most 16 serial attempts, 250 ms between attempts, 96 KiB total bodies, 16 KiB per response, within the assessment deadline and scope expiry.',
    'HEAD/OPTIONS inspect headers without reading bodies. Schema discovery reads a body only for HTTP 200 with a supported JSON content type, avoiding oversized HTML/error pages. Body policy is recorded per observation.',
    'Schema metadata is untrusted declaration, not deployed API inventory. Only two literal root-mapped GET paths are sampled using HEAD and OPTIONS; other operations and schema mappings remain unknown. Without a usable path, /api and /api/v1 are sampled as prefixes only.',
    'No credentials, cookies, response bodies, schema descriptions or arbitrary headers are persisted. CORS checks use one fixed unrelated origin; acceptance does not prove arbitrary-origin reflection or authenticated readability.',
    'The marker path may exist or return a SPA fallback. Error signatures are indications, not proof of a vulnerability. Banners never establish a CVE match.',
  );
  return finish(a);
}
