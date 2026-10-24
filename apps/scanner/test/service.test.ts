import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerRunInput } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, sourceDigest } from '@gotchu/customer-assessment';
import { createScannerClient,createScannerServer,signScannerBody,verifyScannerSignature } from '../src/index.js';
const secret=randomBytes(32);const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
function input():CustomerRunInput{const snapshot={revision:'user-upload',files:[{path:'main.ts',content:'export const hello = 1;'}]};return {version:2,organizationId:randomUUID(),applicationId:randomUUID(),jobId:randomUUID(),applicationName:'Customer',mode:'internal',source:{...snapshot,id:randomUUID(),digest:sourceDigest(snapshot)},target:null};}
const runner=()=>createCustomerAssessmentRunner({scanners:{run:async()=>{throw new Error('fixture-unavailable');},readiness:async()=>({ready:false,tools:[]})}});
async function listen(server:ReturnType<typeof createServer>){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error();cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});return `http://127.0.0.1:${address.port}`;}
async function post(origin:string,body:Buffer,timestamp=String(Math.floor(Date.now()/1000)),signature=signScannerBody(secret,timestamp,body)){
 return new Promise<number>((resolve,reject)=>{const req=request(new URL('/v1/assessments',origin),{method:'POST',headers:{'content-type':'application/json','content-length':body.length,'x-gotchu-timestamp':timestamp,'x-gotchu-signature':signature}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));});req.on('error',reject);req.end(body);});
}
describe('service authentication and client',()=>{
 it('uses fixed-prefix raw-body HMAC and rejects tampering/expiry/invalid lengths',()=>{
  const now=Date.now(),timestamp=String(Math.floor(now/1000)),bytes=Buffer.from('{"x":1}'),signature=signScannerBody(secret,timestamp,bytes);
  expect(verifyScannerSignature(secret,timestamp,signature,bytes,now)).toBe(true);expect(verifyScannerSignature(secret,timestamp,signature,Buffer.from('{ "x":1}'),now)).toBe(false);expect(verifyScannerSignature(secret,timestamp,signature,bytes,now+61000)).toBe(false);expect(verifyScannerSignature(secret,timestamp,'a',bytes,now)).toBe(false);
 });
 it('roundtrips exact v2 input and rejects repeated signed requests',async()=>{
  const run=vi.fn(runner().run);const origin=await listen(createScannerServer({secret,runner:{run,readiness:runner().readiness}}));const request=input();
  const client=createScannerClient({origin,secret,allowDevelopmentHttp:true});const report=await client.run(request);expect(run).toHaveBeenCalledWith(request);expect(report.subject.sourceDigest).toBe(request.source?.digest);expect(report.internal?.status).toBe('unavailable');
  await expect(client.run(request)).rejects.toThrow('scanner_http_409');
 });
 it('rejects unauthorized/tampered requests before executing the runner',async()=>{
  const run=vi.fn(runner().run);const origin=await listen(createScannerServer({secret,runner:{run,readiness:runner().readiness}}));const bytes=Buffer.from(JSON.stringify(input()));
  expect(await post(origin,bytes,undefined,'a'.repeat(64))).toBe(401);expect(run).not.toHaveBeenCalled();
  expect(await post(origin,bytes,String(Math.floor(Date.now()/1000)-120))).toBe(401);expect(run).not.toHaveBeenCalled();
 });
 it('rejects malformed and oversized signed inputs',async()=>{
  const run=vi.fn(runner().run);const origin=await listen(createScannerServer({secret,runner:{run,readiness:runner().readiness}}));
  expect(await post(origin,Buffer.from('{bad'))).toBe(400);expect(await post(origin,Buffer.from(JSON.stringify({...input(),url:'https://attacker.org'})))).toBe(400);expect(await post(origin,Buffer.alloc(4_500_001))).toBe(400);expect(run).not.toHaveBeenCalled();
 });
 it('reports unavailable readiness honestly',async()=>{
  const origin=await listen(createScannerServer({secret,runner:runner()}));const response=await fetch(`${origin}/readyz`);expect(response.status).toBe(503);expect((await response.json()).ready).toBe(false);
 });
 it.each(['http://localhost:4400','http://127.1:4400','http://10.0.0.1:4400','https://user:pass@scanner.org','https://scanner.org/path','https://scanner.org?foo=1'])('rejects service origin %s',origin=>expect(()=>createScannerClient({origin,secret,allowDevelopmentHttp:true})).toThrow());
 it('requires explicit development HTTP opt-in and refuses it in production',()=>{
  expect(()=>createScannerClient({origin:'http://127.0.0.1:4400',secret})).toThrow();const prior=process.env.NODE_ENV;process.env.NODE_ENV='production';try{expect(()=>createScannerClient({origin:'http://127.0.0.1:4400',secret,allowDevelopmentHttp:true})).toThrow();}finally{process.env.NODE_ENV=prior;}
 });
 it('client rejects report scope substitution and refuses redirects',async()=>{
  const wrong=await runner().run(input());const origin=await listen(createServer((_,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(wrong))));await expect(createScannerClient({origin,secret,allowDevelopmentHttp:true}).run(input())).rejects.toThrow('subject_mismatch');
  const redirect=await listen(createServer((_,res)=>res.writeHead(302,{location:'http://169.254.169.254'}).end()));await expect(createScannerClient({origin:redirect,secret,allowDevelopmentHttp:true}).run(input())).rejects.toThrow('scanner_http_302');
 });
 it('bounds client streaming and stalled responses',async()=>{
  const huge=await listen(createServer((_,res)=>res.writeHead(200,{'content-type':'application/json'}).end('x'.repeat(1_048_577))));await expect(createScannerClient({origin:huge,secret,allowDevelopmentHttp:true}).run(input())).rejects.toThrow('response_limit');
  const stalled=await listen(createServer(()=>{}));await expect(createScannerClient({origin:stalled,secret,allowDevelopmentHttp:true,timeoutMs:20}).run(input())).rejects.toThrow('transport_unavailable');
 });
 it('allows only one active run',async()=>{
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const actual=runner();const run=vi.fn(async(data:CustomerRunInput)=>{await gate;return actual.run(data);});const origin=await listen(createScannerServer({secret,runner:{run,readiness:actual.readiness}}));const client=createScannerClient({origin,secret,allowDevelopmentHttp:true});const first=client.run(input());await vi.waitFor(()=>expect(run).toHaveBeenCalledTimes(1));await expect(client.run(input())).rejects.toThrow('scanner_http_429');release();await first;
 });
});
