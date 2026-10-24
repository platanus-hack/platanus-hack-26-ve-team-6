import { describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

const result={image:'fixture-trivy',version:'0.67.2',profileChecksum:'0'.repeat(64),output:{SchemaVersion:2,Results:[{Target:'valid.yaml',Misconfigurations:[{ID:'KSV001',AVDID:'AVD-KSV-0001',Title:'Fixture finding',Description:'Fixture configuration indication',Resolution:'Review configuration',Severity:'HIGH'}]}]}};
const scanners={...absentScanners,async run(name:string){if(name!=='trivy')throw new Error('fixture-unavailable');return result;}};
describe('configuration coverage',()=>{
  it.each(['broken.yaml','broken.yml','nested/broken.json'])('retains available findings and marks omitted %s unknown',async path=>{
    const report=await createCustomerAssessmentRunner({scanners}).run(input([{path:'valid.yaml',content:'kind: Pod'},{path,content:'[unclosed'}]));
    expect(report.internal?.findings).toHaveLength(1);
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')).toMatchObject({state:'unavailable',detail:expect.stringContaining('1 candidate')});
    expect(report.internal?.status).toBe('partial');
  });
  it('reports inspected only when each candidate is represented, allowing normalized absolute paths',async()=>{
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'/source/valid.yaml'}]}};}}}).run(input([{path:'valid.yaml',content:'kind: Pod'}]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('inspected');
  });
  it.each([true,false])('distinguishes omitted candidates from no configuration candidates: %s',async hasCandidate=>{
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2}};}}}).run(input([{path:hasCandidate?'broken.yaml':'app.ts',content:'[unclosed'}]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe(hasCandidate?'unavailable':'unsupported');
  });
  it('does not count duplicate or unknown result targets as coverage of an omitted file',async()=>{
    for(const target of ['valid.yaml','unknown.yaml']){
      const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'valid.yaml'},{Target:target}]}};}}}).run(input([{path:'valid.yaml',content:''},{path:'omitted.yaml',content:''}]));
      expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('unavailable');
    }
  });
});
