import { request } from 'node:http';
import type { DemoRevision } from '@gotchu/contracts';
import { addEvidence, addFinding, createAnalysis, finishAnalysis } from './evidence.js';
import { externalTool, type ControlledTransportOptions } from './profile.js';

const observedHeaders = new Set(['content-security-policy', 'content-type', 'x-powered-by']);
type HttpCapture = {
  url: string;
  method: 'GET';
  status: number;
  // Base64 retains the selected header strings without JSON escaping expanding the evidence cap.
  selectedHeaders: Array<{ name: string; valueBase64: string }>;
  bodyBase64: string;
  bodyComplete: boolean;
  problem: string | null;
};

function observe(url: URL, options: ControlledTransportOptions): Promise<HttpCapture | null> {
  return new Promise((resolve) => {
    let done = false;
    let capture: HttpCapture | null = null;
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish('deadline_exceeded'), options.timeoutMs);
    const outgoing = request(url, {
      method: 'GET', agent: false, maxHeaderSize: 8_192,
      // No proxy, DNS name, cookies, authorization, client-selected headers or redirects.
      headers: { accept: 'text/html', 'accept-encoding': 'identity', connection: 'close', 'user-agent': 'Gotchu-Controlled-Assessment/1.0' },
    }, (response) => {
      capture = { url: url.href, method: 'GET', status: response.statusCode ?? 0, selectedHeaders: [], bodyBase64: '', bodyComplete: false, problem: null };
      // Install error handlers before any early refusal destroys an unfinished response.
      response.on('error', () => finish('response_error'));
      response.on('aborted', () => finish('response_aborted'));
      let headerBytes = 0;
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index]?.toLowerCase();
        const value = response.rawHeaders[index + 1];
        if (!name || value === undefined || !observedHeaders.has(name)) continue;
        if (capture.selectedHeaders.some((header) => header.name === name)) {
          finish('duplicate_selected_header_unsupported');
          return;
        }
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        if (headerBytes > 512) {
          finish('selected_header_limit');
          return;
        }
        capture.selectedHeaders.push({ name, valueBase64: Buffer.from(value).toString('base64') });
      }
      if (capture.status >= 300 && capture.status < 400) { finish('redirect_refused'); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        finish('encoded_body_unsupported'); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        const remaining = options.maxBodyBytes - size;
        const part = chunk.subarray(0, remaining);
        chunks.push(part);
        size += part.length;
        if (chunk.length > remaining) finish('body_limit');
      });
      response.on('end', () => finish(null));
    });
    function finish(problem: string | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (capture) {
        capture.bodyBase64 = Buffer.concat(chunks, size).toString('base64');
        capture.bodyComplete = problem === null;
        capture.problem = problem;
      }
      outgoing.destroy();
      resolve(capture);
    }
    outgoing.on('error', () => finish('connection_error'));
    outgoing.end();
  });
}

export async function assessExternal(revision: DemoRevision, options: ControlledTransportOptions) {
  // The URL is assembled exclusively from validated operator settings and a contract enum.
  const url = new URL(revision === 'vulnerable' ? '/vulnerable' : '/corrected', options.origin);
  const analysis = createAnalysis('external', externalTool, `controlled-demo-store/${revision}`);
  analysis.limitations.push(
    `One allowlisted GET, no retries or redirects; ${options.timeoutMs} ms total deadline, ${options.maxBodyBytes} byte body cap and 8192 byte header cap. Only content-type, content-security-policy and x-powered-by are retained (512 bytes combined).`,
    'No repository, manifest, source, installed-package inventory, authenticated route, JavaScript execution, TLS, cloud, exploit, injection or scanning-service access is used.',
    'HTTP evidence is a UTF-8 JSON capture: selected header values and body bytes are base64. Its checksum covers that capture, not raw HTTP framing or omitted headers. A truncated body or failed request gives partial/unavailable coverage.',
    'A header or version banner can be supplied by an intermediary or be misleading; it cannot prove installed technology, vulnerability, exploitation or compromise.',
  );
  const capture = await observe(url, options);
  if (!capture) {
    analysis.coverage.push({ capability: 'http.response', state: 'unavailable', detail: 'No response headers were received before connection failure, protocol/header-limit failure or the total deadline. No response bytes or finding are invented.' });
  } else {
    const bytes = Buffer.from(JSON.stringify(capture));
    const evidence = addEvidence(analysis, 'http_response', url.href, bytes);
    analysis.coverage.push({ capability: 'http.response', state: 'inspected', detail: `Received HTTP ${capture.status}. Body complete: ${capture.bodyComplete}. Transport limit/failure: ${capture.problem ?? 'none'}.` });
    const contentType = capture.selectedHeaders.find((header) => header.name === 'content-type');
    const isHtml = contentType && /^text\/html(?:\s*;|$)/i.test(Buffer.from(contentType.valueBase64, 'base64').toString());
    const valid = capture.status === 200 && capture.bodyComplete && isHtml;
    if (!valid) {
      analysis.coverage.push({ capability: 'http.catalog-headers', state: 'unavailable', detail: 'Expected a complete HTTP 200 HTML response. Redirects, errors, unsupported content or transport truncation do not support catalog hardening conclusions.' });
    } else {
      analysis.coverage.push({ capability: 'http.catalog-headers', state: 'inspected', detail: 'Inspected Content-Security-Policy presence and a technology banner on this one complete response. Policy effectiveness and other routes remain unknown.' });
      const csp = capture.selectedHeaders.filter((header) => header.name === 'content-security-policy');
      if (!csp.some((header) => Buffer.from(header.valueBase64, 'base64').toString().trim())) addFinding(analysis, {
        ruleId: 'controlled.csp-response', correlationKey: 'http:content-security-policy', title: 'Observed response has no Content-Security-Policy',
        location: url.href, description: 'The complete HTTP 200 catalog response did not include a nonempty Content-Security-Policy header.',
        severity: 'low', confidence: 'observed', impact: 'This response lacks a browser hardening layer. Missing policy alone is not evidence of injection, exploitation or compromise.',
        recommendation: 'Configure an appropriate policy and verify the served catalog response.',
        limitations: ['Only this unauthenticated GET response was observed. No DOM, script execution, policy enforcement or injection test was performed.'], evidenceIds: [evidence.id],
      });
      const banner = capture.selectedHeaders.find((header) => header.name === 'x-powered-by');
      if (banner) addFinding(analysis, {
        ruleId: 'controlled.technology-banner', correlationKey: 'http:technology-banner', title: 'Response exposes a technology banner',
        location: url.href, description: `X-Powered-By advertises ${Buffer.from(banner.valueBase64, 'base64').toString()}. This is an external technology indication, not verified software inventory.`,
        severity: 'informational', confidence: 'inferred', impact: 'The banner discloses a technology label; its presence alone establishes no vulnerability or compromise.',
        recommendation: 'Remove unnecessary banner details and verify inventory independently before drawing vulnerability conclusions.',
        limitations: ['Headers may be spoofed or added by an intermediary. The controlled target deliberately uses a fictional banner.', 'No repository or package-version evidence was consulted by the external check.'], evidenceIds: [evidence.id],
      });
      analysis.coverage.push({ capability: 'external-exploitation', state: 'unsupported', detail: 'No exploit attempt or authenticated/state-changing request is part of this profile.' });
      return finishAnalysis(analysis, 1, 1);
    }
  }
  analysis.coverage.push({ capability: 'external-exploitation', state: 'unsupported', detail: 'No exploit attempt or authenticated/state-changing request is part of this profile.' });
  return finishAnalysis(analysis, 0, 1);
}
