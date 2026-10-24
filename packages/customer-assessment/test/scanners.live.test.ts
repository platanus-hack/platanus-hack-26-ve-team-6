import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
    expect(report.internal?.coverage.filter(c=>['semgrep','gitleaks','trivy'].includes(c.capability))).toEqual(expect.arrayContaining(['semgrep','gitleaks','trivy'].map(capability=>expect.objectContaining({capability,state:'inspected'}))));
    expect(report.internal?.findings.some(f=>f.ruleId.includes('javascript.eval'))).toBe(true);
    expect(report.internal?.findings.some(f=>f.ruleId==='gotchu-assigned-secret')).toBe(true);
    expect(report.internal?.findings.some(f=>f.ruleId.startsWith('AVD-KSV'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('FAKE_ONLY_1234567890_test_secret');
    expect(report.internal?.evidence.every(e=>/^[a-f0-9]{64}$/.test(e.checksum))).toBe(true);
  },60000);
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
});
