import { describe, expect, it, vi } from 'vitest';
import { customerAssessmentReportSchema, CUSTOMER_MAX_SOURCE_FILES, CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, parseLockfile, sourceDigest } from '../src/index.js';
import { input, absentScanners } from './fixtures.js';
describe('customer report boundaries',()=>{
  it('reports unavailable tools and readiness without inventing findings',async()=>{
    const runner=createCustomerAssessmentRunner({scanners:absentScanners});const report=await runner.run(input());
    expect(report.version).toBe(2);expect(report.internal?.status).toBe('unavailable');expect(report.internal?.findings).toEqual([]);expect((await runner.readiness()).ready).toBe(false);expect(customerAssessmentReportSchema.safeParse(report).success).toBe(true);
  });
  it('validates source digest, traversal, source size and no caller URL fields',async()=>{
    const runner=createCustomerAssessmentRunner({scanners:absentScanners});
    const original=input();if(!original.source)throw new Error();original.source.files[0]!.content+='x';await expect(runner.run(original)).rejects.toThrow('digest');
    for(const files of [[{path:'../outside.ts',content:''}],[{path:'script.ts',content:'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES+1)}],[{path:'.env.json',content:''}]])await expect(runner.run(input(files))).rejects.toThrow();
    await expect(runner.run({...input(),url:'https://example.com'} as never)).rejects.toThrow();
  });
  it('accepts realistic source counts and per-file sizes within the shared limits',async()=>{
    const files=Array.from({length:300},(_,i)=>({path:`src/file${i}.ts`,content:'export const x=1;'}));
    files.push({path:'large.ts',content:'// '+ 'x'.repeat(70000)});
    const report=await createCustomerAssessmentRunner({scanners:absentScanners}).run(input(files));expect(report.subject.sourceSnapshotId).toBeTruthy();
    await expect(createCustomerAssessmentRunner({scanners:absentScanners}).run(input(Array.from({length:CUSTOMER_MAX_SOURCE_FILES+1},(_,i)=>({path:`x${i}.ts`,content:''}))))).rejects.toThrow();
  });
  it('uses the backend canonical snapshot digest',()=>{
    const a={revision:'r',files:[{path:'a.ts',content:'x'}]};expect(sourceDigest(a)).toBe(sourceDigest({revision:'r',files:[{content:'x',path:'a.ts'}]}));
  });
  it('bounds a hanging adapter and never evaluates customer source',async()=>{
    const runner=createCustomerAssessmentRunner({deadlineMs:20,scanners:{...absentScanners,run:()=>new Promise(()=>{})}});
    const started=Date.now();const report=await runner.run(input([{path:'danger.ts',content:'throw new Error("MUST_NOT_RUN"); process.exit(99);'}]));expect(Date.now()-started).toBeLessThan(1000);expect(report.internal?.status).toBe('unavailable');
  });
  it('keeps external-only runs independent of scanner and source access',async()=>{
    const run=vi.fn(absentScanners.run);const fixture=input();fixture.mode='external';fixture.source=null;fixture.target={id:fixture.jobId,origin:'https://customer.org',version:3,verifiedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+10000).toISOString()};
    const report=await createCustomerAssessmentRunner({scanners:{...absentScanners,run},https:{lookup:async()=>[{address:'127.0.0.1',family:4}]}}).run(fixture);
    expect(run).not.toHaveBeenCalled();expect(report.internal).toBeNull();expect(report.external?.status).toBe('unavailable');expect(report.subject.targetVersion).toBe(3);
  });
});
describe('lockfile inventory and advisory adapter',()=>{
  const lock={lockfileVersion:3,packages:{'':{dependencies:{alpha:'^1.0.0'}},'node_modules/alpha':{version:'1.2.3'},'node_modules/alpha/node_modules/beta':{version:'2.0.0'},'node_modules/linked':{link:true},'node_modules/ranged':{version:'^3.0.0'}}};
  it.each([2,3])('extracts exact direct/transitive versions from v%s and preserves unknown entries',version=>{
    const source=input([{path:'package-lock.json',content:JSON.stringify({...lock,lockfileVersion:version})}]).source;if(!source)throw new Error();const parsed=parseLockfile(source);expect(parsed.inventory.map(p=>[p.name,p.version,p.relationship])).toEqual([['alpha','1.2.3','direct'],['beta','2.0.0','transitive']]);expect(parsed.unknown).toHaveLength(2);
  });
  it('attributes fixture advisory matches without proving exploitation or severity',async()=>{
    const query=vi.fn(async(_packages: ReadonlyArray<{name:string;version:string}>)=>[{ids:['TEST-1'],complete:true},{ids:[],complete:true}]);
    const report=await createCustomerAssessmentRunner({scanners:absentScanners,advisory:{query}}).run(input([{path:'package-lock.json',content:JSON.stringify(lock)}]));
    expect(query.mock.calls[0]?.[0]).toEqual([{name:'alpha',version:'1.2.3'},{name:'beta',version:'2.0.0'}]);
    expect(report.internal?.findings[0]?.exploitability).toBe('unknown');expect(report.internal?.findings[0]?.severity).toBe('informational');expect(report.comparison[0]?.classification).toBe('unverified');
  });
});
