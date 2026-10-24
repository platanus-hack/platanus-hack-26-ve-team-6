import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { promisify } from 'node:util';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { createCustomerAssessmentRunner, createDockerScanners, createOsvAdapter, profiles } from '../src/index.js';
import { input } from './fixtures.js';
process.env.GOTCHU_SCANNER_TRIVY_DB_DIRECTORY ??= fileURLToPath(new URL('../../../.local/dev/trivy-db', import.meta.url));
describe('actual local Docker scanners (no simulated findings)',()=>{
  it('executes pinned Semgrep, Gitleaks and Trivy profiles against arbitrary uploaded bytes',async()=>{
    vi.stubEnv('NODE_ENV','production');
    try {
      const scanners=createDockerScanners();
      expect((await scanners.readiness()).ready).toBe(true);
      const files=[{path:'src/customer.ts',content:'export function evaluate(userInput: string) { return eval(userInput); }\nconst apiKey = "AKIAQ7XM2V5K8D3P6L9A";'}, {path:'deployment.yaml',content:'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer-pod\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n'}, {path:'package-lock.json',content:'{"name":"customer","lockfileVersion":3,"packages":{"":{"name":"customer"}}}'}];
      const report=await createCustomerAssessmentRunner({scanners}).run(input(files));
      expect(report.internal?.coverage.filter(c=>['semgrep','gitleaks','trivy'].includes(c.capability))).toEqual(expect.arrayContaining(['semgrep','gitleaks'].map(capability=>expect.objectContaining({capability,state:'inspected'}))));
      expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('inspected');
      expect(report.internal?.findings.some(f=>f.ruleId.includes('javascript.eval'))).toBe(true);
      expect(report.internal?.findings.some(f=>f.ruleId==='generic-api-key')).toBe(true);
      expect(report.internal?.findings.some(f=>f.ruleId.startsWith('AVD-KSV'))).toBe(true);
      expect(report.internal?.findings.find(f=>f.ruleId==='AVD-KSV-0017')?.location).toBe('deployment.yaml:10');
      const privilegedFinding=report.internal?.findings.find(f=>f.ruleId==='AVD-KSV-0017');
      const privilegedEvidence=report.internal?.evidence.find(e=>e.id===privilegedFinding?.evidenceIds[0]);
      expect(privilegedEvidence).toMatchObject({tool:{name:'trivy'},kind:'configuration'});
      expect(JSON.parse(privilegedEvidence?.excerpt??'{}')).toMatchObject({checkId:'KSV017',causeStartLine:7,causeEndLine:10,correctionLocationLine:10});
      expect(JSON.stringify(report)).not.toContain('AKIAQ7XM2V5K8D3P6L9A');
      expect(report.internal?.evidence.every(e=>/^[a-f0-9]{64}$/.test(e.checksum))).toBe(true);
      const semgrepProfile=report.internal?.evidence.find(e=>e.locator==='scanner-profile:semgrep');
      if (!semgrepProfile) throw new Error('missing_semgrep_profile_provenance');
      expect(semgrepProfile.tool).toEqual({name:'semgrep',version:profiles.semgrep.version});
      const provenanceSchema=z.object({image:z.string(),matched:z.number(),scanned:z.number()});
      const payload:unknown=JSON.parse(semgrepProfile.excerpt);
      expect(provenanceSchema.parse(payload)).toMatchObject({image:profiles.semgrep.image,matched:1,scanned:1});
    } finally { vi.unstubAllEnvs(); }
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
    expect(report.internal?.coverage.find(c=>c.capability==='trivy_kubernetes')).toMatchObject({state:'unavailable',detail:expect.stringContaining('malformado')});
    expect(report.internal?.status).toBe('partial');
  },15000);
  it('matches curated SAST rules in four languages and keeps corrected controls clean',async()=>{
    const scanners=createDockerScanners();
    const source=input([
      {path:'src/unsafe.js',content:'export function run(value) { return eval(value); }'},
      {path:'src/safe.js',content:'export function run(value) { return JSON.parse(value); }'},
      {path:'src/unsafe.py',content:'import subprocess\ndef run(command):\n    return subprocess.run(command, shell=True)'},
      {path:'src/safe.py',content:'import subprocess\ndef run(command):\n    return subprocess.run(["echo", command], shell=False)'},
      {path:'src/unsafe.go',content:'package main\nimport "os/exec"\nfunc run(command string) { exec.Command("sh", "-c", command) }'},
      {path:'src/safe.go',content:'package main\nimport "os/exec"\nfunc run(command string) { exec.Command("echo", command) }'},
      {path:'src/Unsafe.java',content:'class Unsafe { void run(String command) throws Exception { Runtime.getRuntime().exec(command); } }'},
      {path:'src/Safe.java',content:'class Safe { void run(String command) throws Exception { new ProcessBuilder("echo", command).start(); } }'},
    ]).source;
    if(!source)throw new Error('missing_source');
    const result=await scanners.run('semgrep',source,AbortSignal.timeout(45_000));
    const report=z.object({results:z.array(z.object({check_id:z.string(),path:z.string(),extra:z.object({severity:z.string(),metadata:z.record(z.string(),z.unknown())})}))}).parse(result.output);
    const expected=[
      ['src/unsafe.js','gotchu.javascript.eval','CWE-95','WARNING'],
      ['src/unsafe.py','gotchu.python.subprocess-shell','CWE-78','ERROR'],
      ['src/unsafe.go','gotchu.go.shell-exec','CWE-78','ERROR'],
      ['src/Unsafe.java','gotchu.java.runtime-exec','CWE-78','ERROR'],
    ] as const;
    for(const [path,rule,cwe,severity] of expected){
      const finding=report.results.find(item=>item.check_id.endsWith(rule)&&item.path.endsWith(path));
      expect(finding,`${rule} in ${path}`).toBeDefined();
      expect(finding?.extra).toMatchObject({severity,metadata:{cwe,precision_note:expect.any(String)}});
      const correctedPath=path.replace('unsafe','safe').replace('Unsafe','Safe');
      expect(report.results.some(item=>item.check_id.endsWith(rule)&&item.path.endsWith(correctedPath))).toBe(false);
    }
  },60000);
  it('uses the pinned full Gitleaks defaults with redacted secret output and a clean control',async()=>{
    const source=input([
      {path:'src/credentials.ts',content:'const apiKey = "AKIAQ7XM2V5K8D3P6L9A";'},
      {path:'src/public.ts',content:'const token = "not-a-secret";'},
    ]).source;
    if(!source)throw new Error('missing_source');
    const result=await createDockerScanners().run('gitleaks',source,AbortSignal.timeout(45_000));
    const report=z.array(z.object({RuleID:z.string(),File:z.string(),StartLine:z.number(),Secret:z.string().optional()})).parse(result.output);
    expect(report.some(item=>item.File.endsWith('src/credentials.ts'))).toBe(true);
    expect(report.some(item=>item.File.endsWith('src/public.ts'))).toBe(false);
    expect(JSON.stringify(report)).not.toContain('AKIAQ7XM2V5K8D3P6L9A');
  },60000);
  it('detects Terraform and Dockerfile misconfiguration with corrected negative controls',async()=>{
    const source=input([
      {path:'main.tf',content:'resource "aws_s3_bucket" "public" {\n  bucket = "gotchu-live-public-fixture"\n  acl = "public-read"\n}'},
      {path:'private.tf',content:'resource "aws_s3_bucket" "private" {\n  bucket = "gotchu-live-private-fixture"\n  acl = "private"\n}'},
      {path:'Dockerfile',content:'FROM alpine:3.23.2\nCMD ["true"]\n'},
      {path:'Dockerfile.fixed',content:'FROM alpine:3.23.2\nUSER 10001\nCMD ["true"]\n'},
    ]).source;
    if(!source)throw new Error('missing_source');
    const result=await createDockerScanners().run('trivy',source,AbortSignal.timeout(45_000));
    const report=z.object({Results:z.array(z.object({Target:z.string(),Misconfigurations:z.array(z.object({ID:z.string()})).optional()}))}).parse(result.output);
    const hits=(target:string)=>report.Results.find(item=>item.Target.endsWith(target))?.Misconfigurations??[];
    expect(hits('main.tf').some(item=>item.ID==='AVD-AWS-0092')).toBe(true);
    expect(hits('private.tf').some(item=>item.ID==='AVD-AWS-0092')).toBe(false);
    expect(hits('Dockerfile').some(item=>item.ID==='DS002')).toBe(true);
    expect(hits('Dockerfile.fixed').some(item=>item.ID==='DS002')).toBe(false);
  },60000);
  it('finds CVEs and fixed versions in an old digest-pinned image, with a current-image negative control',async()=>{
    const runner=createCustomerAssessmentRunner({scanners:createDockerScanners()});
    const docker=(...args:string[])=>promisify(execFile)('docker',['--host','unix:///var/run/docker.sock',...args]);
    const oldReference='docker.io/library/alpine@sha256:a15790640a6690aa1730c38cf0a440e2aa44aaca9b0e8931a9f2b0d7cc90fd65';
    const currentReference='docker.io/library/alpine@sha256:1882fa4569e0c591ea092d3766c4893e19b8901a8e649de7067188aba3cc0679';
    const preexisting=await docker('image','inspect',oldReference).then(()=>true,()=>false);
    const assess=(reference:string,digest:string)=>runner.run({
      ...input([]),inputKind:'container_image',source:null,mode:'internal',target:null,
      containerImage:{kind:'registry',reference,digest},
    });
    try {
      const vulnerable=await assess(oldReference,'a15790640a6690aa1730c38cf0a440e2aa44aaca9b0e8931a9f2b0d7cc90fd65');
      const fixed=await assess(currentReference,'1882fa4569e0c591ea092d3766c4893e19b8901a8e649de7067188aba3cc0679');
      const oldCves=vulnerable.internal?.findings.filter(item=>/^CVE-/.test(item.ruleId))??[];
      expect(oldCves.length).toBeGreaterThan(0);
      expect(oldCves.some(item=>{
        const details=vulnerable.internal?.evidence.find(entry=>entry.id===item.evidenceIds[0]);
        const payload: unknown = details ? JSON.parse(details.excerpt) : null;
        const parsed = z.object({ fixedVersion: z.string().nullable() }).safeParse(payload);
        return parsed.success && parsed.data.fixedVersion !== null;
      })).toBe(true);
      expect(fixed.internal?.findings.some(item=>oldCves.some(old=>old.ruleId===item.ruleId))).toBe(false);
      expect(vulnerable.subject.containerImageDigest).toBe('a15790640a6690aa1730c38cf0a440e2aa44aaca9b0e8931a9f2b0d7cc90fd65');
      expect(vulnerable.internal?.coverage).toEqual(expect.arrayContaining([
        expect.objectContaining({capability:'container_image_os_cves',state:'inspected'}),
        expect.objectContaining({capability:'container_image_vulnerability_database',state:'inspected'}),
        expect.objectContaining({capability:'container_image_java_cves',state:'unavailable'}),
      ]));
      expect(vulnerable.internal?.evidence.some(item=>item.excerpt.includes('"diffIDs"'))).toBe(true);
    } finally {
      if (!preexisting) await docker('image','rm','--no-prune',oldReference).catch(()=>{});
      expect(await docker('image','inspect',oldReference).then(()=>true,()=>false)).toBe(preexisting);
    }
  },120000);
  it('scans an uploaded docker-save archive as bytes and retains image-layer CVE evidence',async()=>{
    const reference='docker.io/library/alpine@sha256:a15790640a6690aa1730c38cf0a440e2aa44aaca9b0e8931a9f2b0d7cc90fd65';
    const docker=(...args:string[])=>promisify(execFile)('docker',['--host','unix:///var/run/docker.sock',...args]);
    const preexisting=await docker('image','inspect',reference).then(()=>true,()=>false);
    const directory=await mkdtemp(join(tmpdir(),'gotchu-image-archive-live-'));
    const archivePath=join(directory,'image.tar');
    try {
      if(!preexisting)await docker('pull','--platform','linux/amd64',reference);
      await docker('image','save','--output',archivePath,reference);
      const archive=await readFile(archivePath);
      expect(archive.byteLength).toBeGreaterThan(0);
      expect(archive.byteLength).toBeLessThanOrEqual(8_388_608);
      const archiveDigest=createHash('sha256').update(archive).digest('hex');
      const report=await createCustomerAssessmentRunner({scanners:createDockerScanners()}).run({
        ...input([]),inputKind:'container_image',source:null,mode:'internal',target:null,
        containerImage:{kind:'archive',id:randomUUID(),digest:archiveDigest,size:archive.byteLength,archiveBase64:archive.toString('base64')},
      });
      expect(report.internal?.findings.some(item=>/^CVE-/.test(item.ruleId))).toBe(true);
      expect(report.internal?.evidence.some(item=>item.excerpt.includes('"diffIDs"'))).toBe(true);
      expect(report.subject.containerImageDigest).toBe(archiveDigest);
    } finally {
      await rm(directory,{recursive:true,force:true});
      if(!preexisting)await docker('image','rm','--no-prune',reference).catch(()=>{});
      expect(await docker('image','inspect',reference).then(()=>true,()=>false)).toBe(preexisting);
    }
  },120000);
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
