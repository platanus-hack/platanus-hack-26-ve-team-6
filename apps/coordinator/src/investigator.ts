import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { investigationResultSchema, runCapabilityClaimsSchema } from '@gotchu/agent';
import type { Investigator } from './jobs.js';
import { z } from 'zod';

async function readResult(response: Response) {
  if (!response.body || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new Error('Invalid investigation response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 40_960) { await reader.cancel(); throw new Error('Investigation response exceeds its bound'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  return z.object({ result: investigationResultSchema }).strict().parse(payload).result;
}

export async function createHttpInvestigator(options: { workerUrl: string; privateKeyPem: string; allowLoopbackHttp?: boolean }): Promise<Investigator> {
  const url = new URL(options.workerUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(options.allowLoopbackHttp && local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/') throw new Error('Configure a trusted HTTPS worker origin');
  const privateKey: CryptoKey = await importPKCS8(options.privateKeyPem.replace(/\\n/g, '\n'), 'EdDSA');
  return {
    async investigate(input) {
      const now = Math.floor(Date.now() / 1000);
      const expires = Math.min(now + 295, Math.floor(input.deadline.getTime() / 1000));
      if (expires <= now) throw new Error('Investigation deadline has elapsed');
      const claims = runCapabilityClaimsSchema.parse({
        iss: 'gotchu-run-capability-issuer', aud: 'gotchu-investigation-worker', sub: input.runId,
        jti: randomUUID(), iat: now, exp: expires, organizationId: input.organizationId,
        applicationId: input.applicationId, runId: input.runId,
        allowedReadTools: ['evidence.read', 'auth.events.read', 'application.context.read', 'finding.details.read',
          'source.excerpt.read', 'assessment.diff.read', 'validation.results.read', 'triage.results.read'], evidenceIds: input.evidenceIds,
      });
      const capability = await new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).sign(privateKey);
      const response = await fetch(new URL('/v1/investigations', url), {
        method: 'POST', headers: { authorization: `RunCapability ${capability}` },
        signal: AbortSignal.timeout(Math.min(240_000, Math.max(1, input.deadline.getTime() - Date.now() - 1000))), redirect: 'error',
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Investigation worker returned HTTP ${response.status}`); }
      return readResult(response);
    },
  };
}
