import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { RequestListener as HttpListener } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpsProbe, isPublicAddress } from '../src/https.js';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { input, absentScanners } from './fixtures.js';
let directory:string;let cert:string;let key:string;
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'gotchu-tls-fixture-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=customer.org','-addext','subjectAltName=DNS:customer.org'],{stdio:'ignore'});
  cert=await readFile(join(directory,'cert.pem'),'utf8');key=await readFile(join(directory,'key.pem'),'utf8');
});
afterAll(async()=>rm(directory,{recursive:true,force:true}));
async function fixture(handler:HttpListener){
  let connections=0;const server=createServer({cert,key},handler);server.on('connection',()=>{connections++;});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error();
  return {port:address.port,connections:()=>connections,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
describe('public address policy',()=>{
  it.each(['0.0.0.0','10.2.3.4','127.0.0.1','169.254.169.254','100.100.100.200','172.16.0.2','192.168.1.1','192.0.2.1','198.51.100.2','203.0.113.1','198.19.0.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fe80::1','fc00::1','ff02::1','2001:db8::1','2002:0808:0808::1','3fff::1'])('rejects reserved/private/mapped address %s',address=>expect(isPublicAddress(address)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])('permits global address %s',address=>expect(isPublicAddress(address)).toBe(true));
  it('rejects any private answer in a mixed DNS response',async()=>{
    const probe=createHttpsProbe({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]});await expect(probe('https://customer.org',AbortSignal.timeout(1000))).rejects.toThrow('nonpublic_dns');
  });
});
describe('actual HTTPS sockets with scoped test CA and port',()=>{
  it('verifies hostname/certificate, re-resolves each operation, observes missing headers and never reads source',async()=>{
    const seen:string[]=[];const target=await fixture((req,res)=>{seen.push(`${req.method} ${req.url}`);expect(req.headers.cookie).toBeUndefined();expect(req.headers.authorization).toBeUndefined();res.writeHead(200,{'server':'Unverified/1.2'}).end('hello');});
    try{
      const lookup=vi.fn(async()=>[{address:'127.0.0.1',family:4}]);const options={lookup,testFixture:{hostname:'customer.org',port:target.port,ca:cert}};
      const probe=createHttpsProbe(options);expect((await probe('https://customer.org',AbortSignal.timeout(1000))).tlsVerified).toBe(true);await probe('https://customer.org',AbortSignal.timeout(1000));expect(lookup).toHaveBeenCalledTimes(2);
      const request=input();request.mode='external';request.source=null;request.target={id:request.jobId,origin:'https://customer.org',version:7,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
      const report=await createCustomerAssessmentRunner({scanners:absentScanners,https:options}).run(request);expect(report.external?.status).toBe('completed');expect(report.external?.findings.find(f=>f.ruleId==='https.technology-banner')?.confidence).toBe('inferred');expect(report.external?.findings.find(f=>f.ruleId.includes('content-security-policy'))?.confidence).toBe('observed');expect(seen).toEqual(['GET /','GET /','GET /']);
    }finally{await target.close();}
  });
  it.each(['async DNS','delayed timer'] as const)('never opens TLS or sends GET when authorization expires during %s',async kind=>{
    let requests=0,connections=0;
    const target=await fixture((_,res)=>{requests++;res.end('must not be requested');});
    // Count TCP connections too: an expired target must not reach TLS negotiation.
    const request=input();request.mode='external';request.source=null;
    request.target={id:request.jobId,origin:'https://customer.org',version:1,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+150).toISOString()};
    try {
      const report=await createCustomerAssessmentRunner({https:{testFixture:{hostname:'customer.org',port:target.port,ca:cert},lookup:async()=>{
        if(kind==='async DNS')await new Promise(resolve=>setTimeout(resolve,350));
        else {const until=Date.now()+350;while(Date.now()<until){/* Exercise the explicit wall-clock check before abort timers run. */}}
        return [{address:'127.0.0.1',family:4}];
      }}}).run(request);
      connections=target.connections();
      expect(requests).toBe(0);expect(connections).toBe(0);
      expect(report.external?.status).toBe('unavailable');
      expect(report.external?.coverage.find(c=>c.capability==='public_https_root')?.state).toBe('unavailable');
    } finally {await target.close();}
  });
  it('caps an in-progress HTTPS request by remaining authorization time',async()=>{
    let requests=0;const target=await fixture(()=>{requests++;});
    try {
      const started=Date.now();
      const probe=createHttpsProbe({lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:target.port,ca:cert}});
      await expect(probe('https://customer.org',AbortSignal.timeout(5000),new Date(Date.now()+150).toISOString())).rejects.toThrow();
      expect(requests).toBe(1);expect(Date.now()-started).toBeLessThan(1000);
    } finally {await target.close();}
  });
  it('rejects wrong hostname even with a trusted test CA',async()=>{
    const target=await fixture((_,res)=>res.end('no'));
    try{const probe=createHttpsProbe({lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'different.org',port:target.port,ca:cert}});await expect(probe('https://different.org',AbortSignal.timeout(1000))).rejects.toThrow();}finally{await target.close();}
  });
  it('does not follow redirects or retain response bodies/cookies',async()=>{
    const target=await fixture((_,res)=>res.writeHead(302,{location:'http://169.254.169.254/private','set-cookie':'secret=never-store'}).end('sensitive body'));
    try{const result=await createHttpsProbe({lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:target.port,ca:cert}})('https://customer.org',AbortSignal.timeout(1000));expect(result.incomplete).toBe('redirect_refused');expect(JSON.stringify(result)).not.toContain('secret');}finally{await target.close();}
  });
  it.each(['body','headers','timeout'])('bounds %s',async kind=>{
    const target=await fixture((_,res)=>{if(kind==='headers')res.writeHead(200,{'x-large':'x'.repeat(10000)}).end();else if(kind==='body')res.end('x'.repeat(20000));});
    try{const task=createHttpsProbe({lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:target.port,ca:cert}})('https://customer.org',AbortSignal.timeout(100));if(kind==='body')expect((await task).incomplete).toBe('body_limit');else await expect(task).rejects.toThrow();}finally{await target.close();}
  });
});
