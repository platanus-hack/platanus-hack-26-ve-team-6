import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { RequestListener as HttpListener } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpsPageProbe, createHttpsProbe, isPublicAddress } from '../src/https.js';
import { assertReportBinding, createCustomerAssessmentRunner, createPublicSurfaceProbe } from '../src/index.js';
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
  it('rejects unsafe request paths before DNS or socket creation',async()=>{
    const lookup=vi.fn(async()=>[{address:'127.0.0.1',family:4}]);
    const probe=createHttpsPageProbe({lookup,testFixture:{hostname:'customer.org',port:8443,ca:cert}});
    for(const path of ['//attacker.example/x','/../admin','/%2e%2e/admin','/private?token=1','/private#section','/%2f%2fattacker.example']) {
      await expect(probe('https://customer.org',path,AbortSignal.timeout(1000),new Date(Date.now()+10000).toISOString())).rejects.toThrow('invalid_https_path');
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it('discovers bounded same-origin entrypoints and excludes hostile, query, fragment and traversal links',async()=>{
    const seen:string[]=[];
    const target=await fixture((req,res)=>{
      seen.push(`${req.method} ${req.url}`);
      expect(req.headers.host).toBe('customer.org');
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      if(req.url==='/') {
        res.writeHead(200,{'content-type':'text/html'}).end([
          '<a href="/about">About</a>', '<a href="/docs">Docs</a>', '<a href="/contact">Contact</a>',
          '<a href="/status">Status</a>', '<a href="/faq">FAQ</a>', '<a href="/search?key=secret">Search</a>',
          '<a href="/section#part">Fragment</a>', '<a href="/%2e%2e/admin">Traversal</a>',
          '<a href="https://other.example/private">Other host</a>', '<a href="//other.example/external">Protocol relative</a>',
        ].join(''));
      } else if(req.url==='/.well-known/security.txt') {
        res.writeHead(302,{location:'https://other.example/private'}).end();
      } else if(req.url==='/robots.txt') {
        res.writeHead(200,{'content-type':'text/plain'}).end('Sitemap: /robots-index.xml\nSitemap: https://other.example/external.xml');
      } else if(req.url==='/sitemap.xml') {
        res.writeHead(200,{'content-type':'application/xml'}).end('<urlset><url><loc>https://customer.org/from-sitemap</loc></url><url><loc>https://customer.org/query?key=secret</loc></url><url><loc>https://other.example/remote</loc></url></urlset>');
      } else res.writeHead(404,{'content-type':'text/plain'}).end('not found');
    });
    const lookup=vi.fn(async(host:string)=>{expect(host).toBe('customer.org');return [{address:'127.0.0.1',family:4}];});
    try {
      const inventory=await createPublicSurfaceProbe({lookup,testFixture:{hostname:'customer.org',port:target.port,ca:cert}})({
        id:'f46ecf37-613d-4bfd-9296-c521503f0bcc',origin:'https://customer.org',version:4,
        verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),scanProfile:'public_surface',
      },AbortSignal.timeout(10000));
      expect(inventory.asset).toEqual({type:'verified_https_origin',targetId:'f46ecf37-613d-4bfd-9296-c521503f0bcc',targetVersion:4,origin:'https://customer.org'});
      expect(inventory.requestAttempts).toBe(10);
      expect(inventory.maxRequests).toBe(10);
      expect(inventory.stoppedBecause).toBe('request_cap');
      expect(inventory.unrequestedEntrypoints).toBeGreaterThan(0);
      expect(seen).toHaveLength(10);
      expect(seen).toContain('GET /about');
      expect(inventory.entrypoints.find(item=>item.path==='/.well-known/security.txt')).toMatchObject({status:302,incomplete:'redirect_refused'});
      expect(seen).not.toContain('GET /search?key=secret');
      expect(seen).not.toContain('GET /section#part');
      expect(seen).not.toContain('GET /admin');
      expect(seen).not.toContain('GET /private');
      expect(seen).not.toContain('GET /external');
      expect(seen).not.toContain('GET /query?key=secret');
      expect(JSON.stringify(inventory)).not.toContain('other.example');
      expect(lookup).toHaveBeenCalledTimes(10);
    } finally {await target.close();}
  });
  it('stops at the aggregate response-byte cap and leaves later paths unknown',async()=>{
    const seen:string[]=[];
    const target=await fixture((req,res)=>{seen.push(`${req.method} ${req.url}`);res.writeHead(200,{'content-type':'text/plain'}).end('x'.repeat(20_000));});
    const lookup=vi.fn(async()=>[{address:'127.0.0.1',family:4}]);
    try {
      const inventory=await createPublicSurfaceProbe({lookup,testFixture:{hostname:'customer.org',port:target.port,ca:cert}})({
        id:'e096af4a-a4a6-449d-a43d-467ce07e0a2a',origin:'https://customer.org',version:1,
        verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+15000).toISOString(),scanProfile:'public_surface',
      },AbortSignal.timeout(10000));
      expect(inventory.responseBytes).toBe(65_536);
      expect(inventory.requestAttempts).toBe(4);
      expect(inventory.stoppedBecause).toBe('response_byte_cap');
      expect(inventory.unrequestedKnownPaths).toContain('/sitemap.xml');
      expect(seen).toHaveLength(4);
      expect(lookup).toHaveBeenCalledTimes(4);
    } finally {await target.close();}
  });
  it('does not open another socket after authorization expires between profile requests',async()=>{
    const seen:string[]=[];
    const target=await fixture((req,res)=>{seen.push(`${req.method} ${req.url}`);res.writeHead(200,{'content-type':'text/html'}).end('<p>bounded</p>');});
    const lookup=vi.fn(async()=>[{address:'127.0.0.1',family:4}]);
    try {
      const inventory=await createPublicSurfaceProbe({lookup,testFixture:{hostname:'customer.org',port:target.port,ca:cert}})({
        id:'a4b0319b-ce1b-4003-8fd2-4a5b326b8ce8',origin:'https://customer.org',version:1,
        verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+180).toISOString(),scanProfile:'public_surface',
      },AbortSignal.timeout(5000));
      expect(seen).toEqual(['GET /']);
      expect(target.connections()).toBe(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(inventory.stoppedBecause).toBe('authorization_expired');
      expect(inventory.entrypoints[1]).toMatchObject({path:'/.well-known/security.txt',requestAttempted:false,incomplete:'authorization_expired'});
    } finally {await target.close();}
  });
  it('routes explicit public_surface input through the bounded profile and preserves report shape',async()=>{
    const seen:string[]=[];
    const target=await fixture((req,res)=>{seen.push(`${req.method} ${req.url}`);res.writeHead(req.url==='/'?200:404,{'content-type':req.url==='/'?'text/html':'text/plain'}).end(req.url==='/'?'<p>hello</p>':'not found');});
    try {
      const request=input();request.mode='external';request.source=null;
      const authorizedTarget={id:request.jobId,origin:'https://customer.org',version:2,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),scanProfile:'public_surface' as const};
      request.target=authorizedTarget;
      const report=await createCustomerAssessmentRunner({scanners:absentScanners,https:{lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:target.port,ca:cert}}}).run(request);
      expect(seen).toEqual(['GET /','GET /.well-known/security.txt','GET /security.txt','GET /robots.txt','GET /sitemap.xml']);
      expect(report.external?.coverage.find(item=>item.capability==='public_surface_known_paths')?.state).toBe('inspected');
      expect(report.external?.coverage.find(item=>item.capability==='authenticated_routes')?.state).toBe('unsupported');
      expect(report.external?.evidence).toHaveLength(5);
      expect(report.limitations[0]).toContain('public-surface HTTPS observations');
      expect(report.mode).toBe('external');
      expect(JSON.stringify(report)).not.toContain('hello');
      expect(()=>assertReportBinding({...request,target:{...authorizedTarget,scanProfile:'root'}},report)).toThrow('report_subject_mismatch');
    } finally {await target.close();}
  });
  it.each(['body','headers','timeout'])('bounds %s',async kind=>{
    const target=await fixture((_,res)=>{if(kind==='headers')res.writeHead(200,{'x-large':'x'.repeat(10000)}).end();else if(kind==='body')res.end('x'.repeat(20000));});
    try{const task=createHttpsProbe({lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:target.port,ca:cert}})('https://customer.org',AbortSignal.timeout(100));if(kind==='body')expect((await task).incomplete).toBe('body_limit');else await expect(task).rejects.toThrow();}finally{await target.close();}
  });
});
