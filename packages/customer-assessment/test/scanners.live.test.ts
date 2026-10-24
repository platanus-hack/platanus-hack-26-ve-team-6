import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { promisify } from 'node:util';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner, createDockerScanners, createOsvAdapter } from '../src/index.js';
import { input } from './fixtures.js';
describe('actual local Docker scanners (no simulated findings)',()=>{
  it('executes pinned Semgrep, Gitleaks and Trivy profiles against arbitrary uploaded bytes',async()=>{
    const scanners=createDockerScanners();expect((await scanners.readiness()).ready).toBe(true);
    const files=[{path:'src/customer.ts',content:'export function evaluate(userInput: string) { return eval(userInput); }\nconst password = "FAKE_ONLY_1234567890_test_secret";'}, {path:'deployment.yaml',content:'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer-pod\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n'}, {path:'package.json',content:'{"scripts":{"postinstall":"exit 99"}}'}];
    const report=await createCustomerAssessmentRunner({scanners}).run(input(files));
    expect(report.internal?.coverage.filter(c=>['semgrep','gitleaks','trivy'].includes(c.capability))).toEqual(expect.arrayContaining(['semgrep','gitleaks'].map(capability=>expect.objectContaining({capability,state:'inspected'}))));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('unavailable'); // package.json was not inspected as Kubernetes configuration.
    expect(report.internal?.findings.some(f=>f.ruleId.includes('javascript.eval'))).toBe(true);
    expect(report.internal?.findings.some(f=>f.ruleId==='gotchu-assigned-secret')).toBe(true);
    expect(report.internal?.findings.some(f=>f.ruleId.startsWith('AVD-KSV'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('FAKE_ONLY_1234567890_test_secret');
    expect(report.internal?.evidence.every(e=>/^[a-f0-9]{64}$/.test(e.checksum))).toBe(true);
  },60000);
  it('retains real Trivy findings while marking an omitted malformed YAML file unknown',async()=>{
    const scanners=createDockerScanners();
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(name,source,signal){
      if(name!=='trivy')throw new Error('not_part_of_this_live_check');
      return scanners.run(name,source,signal);
    }}}).run(input([
      {path:'valid.yaml',content:'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n'},
      {path:'broken.yaml',content:'apiVersion: v1\nkind: Pod\nspec: [unclosed\n'},
    ]));
    expect(report.internal?.findings.some(f=>f.ruleId.startsWith('AVD-KSV'))).toBe(true);
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')).toMatchObject({state:'unavailable',detail:expect.stringContaining('1 candidate')});
    expect(report.internal?.status).toBe('partial');
  },15000);
  it('settles an aborted real Docker run only after removing its container and source directory',async()=>{
    const docker=(...args:string[])=>promisify(execFile)('docker',['--host','unix:///var/run/docker.sock',...args]);
    const marker=`abort-${randomUUID()}.ts`;
    const source=input([{path:marker,content:'export const evaluate = (input: string) => eval(input);'}]).source;
    if(!source)throw new Error('missing_source');
    const controller=new AbortController();
    const work=createDockerScanners().run('semgrep',source,controller.signal);
    // Observe rejection immediately while locating only this test's uniquely marked mount.
    const outcome=work.then(()=> 'completed',()=> 'aborted');
    let container:string|undefined, directory:string|undefined;
    try {
      await expect.poll(async()=>{
        const ids=(await docker('ps','-aq','--filter','name=gotchu-scan-')).stdout.trim().split('\n').filter(Boolean);
        if(!ids.length)return false;
        const raw:unknown=JSON.parse((await docker('inspect',...ids)).stdout);
        const rows=z.array(z.object({Id:z.string(),Mounts:z.array(z.object({Source:z.string(),Destination:z.string()}))})).parse(raw);
        for(const row of rows)for(const mount of row.Mounts)if(mount.Destination==='/source'){
          try{await access(join(mount.Source,marker));container=row.Id;directory=dirname(mount.Source);return true;}catch{/* Another run's mount. */}
        }
        return false;
      },{timeout:10000,interval:50}).toBe(true);
      controller.abort();expect(await outcome).toBe('aborted');
      if(!container||!directory)throw new Error('missing_owned_resources');
      await expect(docker('inspect',container)).rejects.toThrow();
      await expect(access(directory)).rejects.toThrow();
    } finally {
      controller.abort();await outcome;
      // Failure-path cleanup touches only the exact resources identified by our unique marker.
      if(container)await docker('rm','--force',container).catch(()=>{});
      if(directory)await rm(directory,{recursive:true,force:true});
    }
  },20000);
  it('queries the actual OSV service with exact package versions only',async()=>{
    const matches=await createOsvAdapter().query([{name:'lodash',version:'4.17.20'},{name:'lodash',version:'4.17.21'}],AbortSignal.timeout(15000));
    expect(matches[0]?.ids).toContain('GHSA-35jh-r3h4-6jhm');expect(matches[1]?.ids).not.toContain('GHSA-35jh-r3h4-6jhm');
  },20000);
  it('correlates only actual pinned Semgrep CSP candidates with scoped local TLS responses',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'gotchu-csp-correlation-'));
    let server: ReturnType<typeof createServer> | undefined;
    try {
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=customer.org','-addext','subjectAltName=DNS:customer.org'],{stdio:'ignore'});
      const ca=await readFile(join(directory,'cert.pem'),'utf8');
      let responseMode:'missing'|'present'|'incomplete'='missing';
      const handler:RequestListener=(_,response)=>{
        if(responseMode==='incomplete'){response.writeHead(302,{location:'/elsewhere'}).end('redirect');return;}
        response.writeHead(200,responseMode==='present'?{'content-security-policy':"default-src 'self'"}:{}).end('ok');
      };
      const tlsServer=createServer({cert:ca,key:await readFile(join(directory,'key.pem'),'utf8')},handler);
      await new Promise<void>((resolve,reject)=>{
        tlsServer.once('error',reject);
        tlsServer.listen(0,'127.0.0.1',resolve);
      });
      server=tlsServer;
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('missing_fixture_address');
      const docker=createDockerScanners();
      let latestSemgrepOutput:unknown;
      const scanners={
        async run(name:Parameters<typeof docker.run>[0],source:Parameters<typeof docker.run>[1],signal:Parameters<typeof docker.run>[2]){
          if(name!=='semgrep')throw new Error('live_csp_case_runs_semgrep_only');
          const result=await docker.run(name,source,signal);
          latestSemgrepOutput=result.output;
          return result;
        },
        async readiness(){return {ready:true,tools:[{name:'semgrep',available:true}]};},
      };
      const runner=createCustomerAssessmentRunner({scanners,https:{lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:address.port,ca}}});
      const disabledTs="// 😀 exercises UTF-8 byte offsets and CRLF parsing\r\nimport h from 'helmet';\r\nconst app = {use(handler: unknown) { return handler; }};\r\napp.use(h({contentSecurityPolicy: false}));\r\n";
      const enabledTs="// 😀 exercises UTF-8 byte offsets and CRLF parsing\r\nimport h from 'helmet';\r\nconst app = {use(handler: unknown) { return handler; }};\r\napp.use(h());\r\n";
      const disabledJs="import shield from 'helmet';\nconst app = {use(handler) { return handler; }};\napp.use(shield({contentSecurityPolicy: false}));";
      const enabledJs="import shield from 'helmet';\nconst app = {use(handler) { return handler; }};\napp.use(shield());";
      const runFiles=async(files:{path:string;content:string}[])=>{
        const request=input(files);
        request.mode='both';
        request.target={id:request.jobId,origin:'https://customer.org',version:1,verifiedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString()};
        return runner.run(request);
      };
      const run=async(disabled:boolean)=>runFiles([
          {path:'src/app.ts',content:disabled?disabledTs:enabledTs},
          {path:'src/app.js',content:disabled?disabledJs:enabledJs},
        ]);

      responseMode='missing';
      const both=await run(true);
      const sourceCandidates=both.internal?.findings.filter(f=>f.correlationKey==='http:content-security-policy')??[];
      expect(sourceCandidates).toHaveLength(2);
      expect(sourceCandidates.every(f=>/^(?:gotchu|profile\.gotchu)\.javascript\.helmet-csp-disabled$/.test(f.ruleId))).toBe(true);
      expect(sourceCandidates.map(f=>f.location).sort()).toEqual(['src/app.js:3','src/app.ts:4']);
      expect(both.external?.findings.find(f=>f.ruleId==='https.missing-content-security-policy')).toBeDefined();
      expect(both.comparison.find(item=>item.key==='http:content-security-policy')?.classification).toBe('both');

      const falsePositiveFiles=[
        {path:'src/shadowed.ts',content:"import h from 'helmet';\nfunction configure(h: unknown) { h({contentSecurityPolicy: false}); }"},
        {path:'src/duplicate.js',content:"import h from 'helmet';\nh({contentSecurityPolicy: false, contentSecurityPolicy: true});"},
        {path:'src/spread.js',content:"import h from 'helmet';\nh({contentSecurityPolicy: false, ...defaults});"},
        {path:'src/type-only.ts',content:"import type h from 'helmet';\nh({contentSecurityPolicy: false});"},
        {path:'src/conflicting.ts',content:"import h from 'helmet';\nimport { other as h } from 'other';\nh({contentSecurityPolicy: false});"},
        {path:'src/hoisted.ts',content:"import h from 'helmet';\nh({contentSecurityPolicy: false});\nfunction unrelated() { if (false) var h; }"},
      ];
      responseMode='missing';
      const falsePositiveReport=await runFiles(falsePositiveFiles);
      const semgrepCandidates=z.object({results:z.array(z.object({check_id:z.string(),path:z.string()}))}).parse(latestSemgrepOutput).results;
      const candidatePaths=semgrepCandidates
        .filter(candidate=>candidate.check_id==='profile.gotchu.javascript.helmet-csp-disabled'||candidate.check_id==='gotchu.javascript.helmet-csp-disabled')
        .map(candidate=>candidate.path.replace(/^\/?source\//,''))
        .sort();
      expect(candidatePaths).toEqual(falsePositiveFiles.map(file=>file.path).sort());
      expect(falsePositiveReport.internal?.findings.some(f=>f.correlationKey==='http:content-security-policy')).toBe(false);
      expect(falsePositiveReport.external?.findings.find(f=>f.ruleId==='https.missing-content-security-policy')).toBeDefined();
      expect(falsePositiveReport.comparison.find(item=>item.key==='http:content-security-policy')).toMatchObject({classification:'unverified',internalFindingIds:[]});

      responseMode='present';
      const sourceOnly=await run(true);
      expect(sourceOnly.comparison.find(item=>item.key==='http:content-security-policy')).toMatchObject({classification:'unverified',externalFindingIds:[]});

      responseMode='missing';
      const responseOnly=await run(false);
      expect(responseOnly.internal?.findings.find(f=>f.correlationKey==='http:content-security-policy')).toBeUndefined();
      expect(responseOnly.comparison.find(item=>item.key==='http:content-security-policy')).toMatchObject({classification:'unverified',internalFindingIds:[]});

      responseMode='incomplete';
      const incomplete=await run(true);
      expect(incomplete.external?.findings.find(f=>f.ruleId==='https.missing-content-security-policy')).toBeUndefined();
      expect(incomplete.comparison.find(item=>item.key==='http:content-security-policy')).toMatchObject({classification:'unverified',externalFindingIds:[]});
    } finally {
      server?.closeAllConnections();
      if(server)await new Promise<void>((resolve,reject)=>server?.close(error=>error?reject(error):resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  },120000);
});
