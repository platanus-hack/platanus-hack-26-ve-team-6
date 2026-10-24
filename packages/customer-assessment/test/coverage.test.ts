import { describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

const result={image:'fixture-trivy',version:'0.67.2',profileChecksum:'0'.repeat(64),output:{SchemaVersion:2,Results:[{Target:'valid.yaml',Misconfigurations:[{ID:'KSV001',AVDID:'AVD-KSV-0001',Title:'Fixture finding',Description:'Fixture configuration indication',Resolution:'Review configuration',Severity:'HIGH'}]}]}};
const scanners={...absentScanners,async run(name:string){if(name!=='trivy')throw new Error('fixture-unavailable');return result;}};
const validManifest='apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\n';
const malformedManifest='apiVersion: v1\nkind: Pod\nspec: [unclosed\n';

describe('configuration coverage',()=>{
  it.each(['broken.yaml','broken.yml','nested/broken.json'])('retains available findings and marks omitted %s unknown',async path=>{
    const malformed=path.endsWith('.json')?'{"apiVersion":"v1","kind":"Pod","spec":[}':malformedManifest;
    const report=await createCustomerAssessmentRunner({scanners}).run(input([{path:'valid.yaml',content:validManifest},{path,content:malformed}]));
    expect(report.internal?.findings).toHaveLength(1);
    expect(report.internal?.coverage.find(c=>c.capability==='trivy_kubernetes')).toMatchObject({state:'unavailable',detail:expect.stringContaining('desconocida')});
    expect(report.internal?.status).toBe('partial');
  });
  it('reports inspected only when each candidate is represented, allowing normalized absolute paths',async()=>{
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'/source/valid.yaml'}]}};}}}).run(input([{path:'valid.yaml',content:validManifest}]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('inspected');
  });
  it.each([true,false])('distinguishes omitted candidates from no configuration candidates: %s',async hasCandidate=>{
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2}};}}}).run(input([{path:hasCandidate?'broken.yaml':'app.ts',content:hasCandidate?malformedManifest:'[unclosed'}]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe(hasCandidate?'unavailable':'unsupported');
  });
  it('ignores a package lock while recognizing multi-document Kubernetes YAML',async()=>{
    const multiDocument='apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: customer\n';
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'k8s.yaml'}]}};}}}).run(input([
      {path:'package-lock.json',content:JSON.stringify({name:'customer',lockfileVersion:3,packages:{'node_modules/library':{version:'1.0.0'}}})},
      {path:'k8s.yaml',content:multiDocument},
    ]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('inspected');
  });
  it('keeps malformed Kubernetes YAML unknown even when Trivy emitted a target result',async()=>{
    const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'broken.yaml'}]}};}}}).run(input([{path:'broken.yaml',content:malformedManifest}]));
    expect(report.internal?.coverage.find(c=>c.capability==='trivy_kubernetes')).toMatchObject({state:'unavailable',detail:expect.stringContaining('malformado')});
  });
  it('does not count duplicate or unknown result targets as coverage of an omitted candidate',async()=>{
    for(const target of ['valid.yaml','unknown.yaml']){
      const report=await createCustomerAssessmentRunner({scanners:{...scanners,async run(){return {...result,output:{SchemaVersion:2,Results:[{Target:'valid.yaml'},{Target:target}]}};}}}).run(input([{path:'valid.yaml',content:validManifest},{path:'omitted.yaml',content:malformedManifest}]));
      expect(report.internal?.coverage.find(c=>c.capability==='trivy')?.state).toBe('unavailable');
    }
  });
});
