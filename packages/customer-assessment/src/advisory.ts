import { request } from 'node:https';
import { z } from 'zod';
import { osvAdvisoryMetadataSchema, type CustomerRunInput, type OsvAdvisoryMetadata } from '@gotchu/contracts';
import type { LockedPackage } from './lockfiles.js';

export { parseLockfile } from './lockfiles.js';
export type { LockedPackage } from './lockfiles.js';

const packageName = z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const prereleasePart = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const exactVersion = z.string().max(100).regex(new RegExp(`^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${prereleasePart}(?:\\.${prereleasePart})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`));
const resultSchema = z.object({results:z.array(z.object({vulns:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),modified:z.string().max(100).optional()})).max(100).optional(),next_page_token:z.string().optional()})).max(100)});
export interface AdvisoryMatch { ids: string[]; complete: boolean; advisories?: OsvAdvisoryMetadata[] }
export interface AdvisoryAdapter { readiness?(): Promise<boolean>; query(packages: ReadonlyArray<Pick<LockedPackage,'name'|'version'>>, signal: AbortSignal): Promise<AdvisoryMatch[]> }

const osvDetailsSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  withdrawn: z.iso.datetime().optional(),
  affected: z.array(z.object({
    package: z.object({ ecosystem: z.string().max(100), name: z.string().max(214) }).passthrough(),
    versions: z.array(z.string().max(100)).max(200).optional(),
    ranges: z.array(z.object({
      type: z.string().max(40),
      events: z.array(z.object({
        introduced: z.string().max(100).optional(), fixed: z.string().max(100).optional(),
        last_affected: z.string().max(100).optional(), limit: z.string().max(100).optional(),
      }).strict().refine(event => Object.keys(event).length === 1)).max(100),
    }).passthrough()).max(20).optional(),
  }).passthrough()).max(50),
}).passthrough();

async function requestJson(path: string, signal: AbortSignal, limit: number): Promise<unknown> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request({ hostname: 'api.osv.dev', port: 443, path, method: 'GET', agent: false, rejectUnauthorized: true, signal, maxHeaderSize: 8192, headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, response => {
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('advisory_http_failed')); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { response.destroy(); reject(new Error('advisory_output_limit')); } else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', () => reject(new Error('advisory_unavailable')));
    });
    req.on('error', () => reject(new Error('advisory_unavailable'))); req.end();
  });
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

async function readAdvisories(ids: readonly string[], parentSignal: AbortSignal): Promise<{ advisories: Map<string, OsvAdvisoryMetadata>; complete: boolean }> {
  const unique = [...new Set(ids)].slice(0, 20);
  const advisories = new Map<string, OsvAdvisoryMetadata>();
  let complete = unique.length === new Set(ids).size;
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8000)]);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (true) {
      const id = unique[cursor++];
      if (!id) return;
      try {
        const raw = await requestJson('/v1/vulns/' + encodeURIComponent(id), signal, 65_536);
        const parsed = osvDetailsSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id) { complete = false; continue; }
        const filtered = parsed.data.affected.filter(item => item.package.ecosystem === 'npm').map(item => ({
          package: { ecosystem: item.package.ecosystem, name: item.package.name },
          ...(item.versions === undefined ? {} : { versions: item.versions }),
          ...(item.ranges === undefined ? {} : { ranges: item.ranges }),
        }));
        const metadata = osvAdvisoryMetadataSchema.safeParse({ id, withdrawn: parsed.data.withdrawn ?? null, affected: filtered });
        if (!metadata.success) { complete = false; continue; }
        advisories.set(id, metadata.data);
      } catch { complete = false; }
    }
  }));
  return { advisories, complete };
}
/** Explicit opt-in: sends only npm package names and exact versions, never source or scope IDs. */
export function createOsvAdapter(): AdvisoryAdapter {
  const adapter: AdvisoryAdapter = {
    async readiness() {
      try { const result=await adapter.query([{name:'lodash',version:'4.17.21'}],AbortSignal.timeout(8000));return result.length===1 && result[0]?.complete===true; } catch {return false;}
    },
    async query(packages,parentSignal) {
    if (packages.length > 200) throw new Error('package_limit');
    const results: AdvisoryMatch[] = [];
    for (let offset = 0; offset < packages.length; offset += 100) {
      const batch = packages.slice(offset,offset+100);
      const body = JSON.stringify({queries:batch.map(p=>({package:{ecosystem:'npm',name:packageName.parse(p.name)},version:exactVersion.parse(p.version)}))});
      const signal = AbortSignal.any([parentSignal,AbortSignal.timeout(8000)]);
      const bytes = await new Promise<Buffer>((resolve,reject)=>{
        const req = request({hostname:'api.osv.dev',port:443,path:'/v1/querybatch',method:'POST',agent:false,rejectUnauthorized:true,signal,maxHeaderSize:8192,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'accept-encoding':'identity'}},res=>{
          if (res.statusCode !== 200 || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('advisory_http_failed')); return; }
          let size = 0; const chunks: Buffer[] = [];
          res.on('data',(chunk: Buffer)=>{size+=chunk.length;if(size>262144){res.destroy();reject(new Error('advisory_output_limit'));}else chunks.push(chunk);});
          res.on('end',()=>resolve(Buffer.concat(chunks))); res.on('error',()=>reject(new Error('advisory_unavailable')));
        });
        req.on('error',()=>reject(new Error('advisory_unavailable')));req.end(body);
      });
      const json: unknown = JSON.parse(bytes.toString('utf8')); const parsed = resultSchema.parse(json);
      if (parsed.results.length !== batch.length) throw new Error('advisory_count_mismatch');
      const idsByPackage = parsed.results.map(result => (result.vulns ?? []).map(vulnerability => vulnerability.id));
      const details = await readAdvisories(idsByPackage.flat(), signal);
      results.push(...parsed.results.map((result, index) => {
        const ids = idsByPackage[index] ?? [];
        return { ids, complete: !result.next_page_token && details.complete && ids.every(id => details.advisories.has(id)), advisories: ids.flatMap(id => {
          const metadata = details.advisories.get(id);
          return metadata ? [metadata] : [];
        }) };
      }));
    }
    return results;
  }};
  return adapter;
}
