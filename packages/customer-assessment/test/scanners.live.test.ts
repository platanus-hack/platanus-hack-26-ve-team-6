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
  it('queries the actual OSV service with exact package versions only',async()=>{
    const matches=await createOsvAdapter().query([{name:'lodash',version:'4.17.20'},{name:'lodash',version:'4.17.21'}],AbortSignal.timeout(15000));
    expect(matches[0]?.ids).toContain('GHSA-35jh-r3h4-6jhm');expect(matches[1]?.ids).not.toContain('GHSA-35jh-r3h4-6jhm');
  },20000);
});
