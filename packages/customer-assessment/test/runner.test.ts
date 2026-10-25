import { describe, expect, it, vi } from 'vitest';
import { customerAssessmentReportSchema, CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, parseLockfile } from '../src/index.js';
import { input, absentScanners } from './fixtures.js';
describe('customer report boundaries',()=>{
  it('reports unavailable tools and readiness without inventing findings',async()=>{
    const runner=createCustomerAssessmentRunner({scanners:absentScanners});const report=await runner.run(input());
    expect(report.version).toBe(2);expect(report.internal?.status).toBe('unavailable');expect(report.internal?.findings).toEqual([]);expect((await runner.readiness()).ready).toBe(false);expect(customerAssessmentReportSchema.safeParse(report).success).toBe(true);
  });
  it('retains partial scanner evidence when every capability is incomplete',async()=>{
    const scanners={...absentScanners,async run(name:string){
      if(name!=='semgrep')throw new Error('fixture-unavailable');
      return {image:'fixture-semgrep-image',version:'1.90.0',profileChecksum:'0'.repeat(64),output:{version:'1.90.0',results:[{check_id:'fixture.partial-eval',path:'/source/app.ts',start:{line:1}}],errors:[{type:'PartialParsing'}],paths:{scanned:['/source/app.ts']}}};
    }};
    const report=await createCustomerAssessmentRunner({scanners}).run(input([{path:'app.ts',content:'eval(value);'}]));
    expect(report.internal?.status).toBe('partial');expect(report.internal?.findings).toHaveLength(1);expect(customerAssessmentReportSchema.safeParse(report).success).toBe(true);
  });
  it('validates source digest, traversal, source size and no caller URL fields',async()=>{
    const runner=createCustomerAssessmentRunner({scanners:absentScanners});
    const original=input();if(!original.source)throw new Error();original.source.files[0]!.content+='x';await expect(runner.run(original)).rejects.toThrow('digest');
    for(const files of [[{path:'../outside.ts',content:''}],[{path:'script.ts',content:'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES+1)}],[{path:'.env.json',content:''}]])await expect(runner.run(input(files))).rejects.toThrow();
    await expect(runner.run({...input(),url:'https://example.com'} as never)).rejects.toThrow();
  });
  it('holds ownership beyond the deadline until every scanner cleanup settles',async()=>{
    let release=()=>{};const cleanup=new Promise<void>(resolve=>{release=resolve;});
    let aborted=0;
    const run=vi.fn(async (_name:unknown,_source:unknown,signal:AbortSignal)=>{
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));
      await cleanup;throw new Error('scanner_aborted');
    });
    let settled=false;
    const work=createCustomerAssessmentRunner({deadlineMs:10,scanners:{...absentScanners,run}}).run(input([{path:'danger.ts',content:'process.exit(99);'}]));
    work.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>expect(aborted).toBe(3));expect(settled).toBe(false);
    release();expect((await work).internal?.status).toBe('unavailable');expect(run).toHaveBeenCalledTimes(3);
  });
  it('waits for a delayed HTTPS sibling and gives scanner cleanup failure precedence without retries',async()=>{
    let releaseLookup=()=>{};const lookupGate=new Promise<void>(resolve=>{releaseLookup=resolve;});let lookupStarted=false;
    const cleanupError=new Error('scanner_cleanup_unavailable');
    const run=vi.fn(async()=>{throw cleanupError;});
    const fixture=input();fixture.mode='both';fixture.target={id:fixture.jobId,origin:'https://customer.org',version:3,authorizedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+10000).toISOString()};
    const runner=createCustomerAssessmentRunner({deadlineMs:20,scanners:{...absentScanners,run},https:{lookup:async()=>{lookupStarted=true;await lookupGate;return[{address:'127.0.0.1',family:4}];}}});
    let settled=false;const work=runner.run(fixture);work.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>{expect(lookupStarted).toBe(true);expect(run).toHaveBeenCalledTimes(3);});
    await new Promise(resolve=>setTimeout(resolve,40));expect(settled).toBe(false);
    releaseLookup();await expect(work).rejects.toBe(cleanupError);
    expect(run).toHaveBeenCalledTimes(3);
    await expect(runner.readiness()).rejects.toBe(cleanupError);
  });
  it('propagates cleanup faults only after sibling operations settle and latches the runner',async()=>{
    let release=()=>{};const cleanup=new Promise<void>(resolve=>{release=resolve;});
    const run=vi.fn(async(name:string)=>{if(name!=='semgrep')await cleanup;throw new Error(name==='semgrep'?'scanner_cleanup_unavailable':'unavailable');});
    const runner=createCustomerAssessmentRunner({scanners:{run,readiness:async()=>({ready:true,tools:[]})},advisory:{query:async()=>[],readiness:async()=>true}});
    let settled=false;const work=runner.run(input());work.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>expect(run).toHaveBeenCalledTimes(3));expect(settled).toBe(false);
    release();await expect(work).rejects.toThrow('scanner_cleanup_unavailable');
    await expect(runner.run(input())).rejects.toThrow('scanner_cleanup_unavailable');expect(run).toHaveBeenCalledTimes(3);
    await expect(runner.readiness()).rejects.toThrow('scanner_cleanup_unavailable');
  });
  it('coalesces and caches aggregate readiness including advisory checks',async()=>{
    let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
    const readiness=vi.fn(async()=>{await gate;return true;});
    const runner=createCustomerAssessmentRunner({scanners:absentScanners,advisory:{query:async()=>[],readiness}});
    const calls=Array.from({length:40},()=>runner.readiness());await vi.waitFor(()=>expect(readiness).toHaveBeenCalledTimes(1));release();await Promise.all(calls);
    await runner.readiness();expect(readiness).toHaveBeenCalledTimes(1);
  });
  it('keeps external-only runs independent of scanner and source access',async()=>{
    const run=vi.fn(absentScanners.run);const fixture=input();fixture.mode='external';fixture.source=null;fixture.target={id:fixture.jobId,origin:'https://customer.org',version:3,authorizedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+10000).toISOString()};
    const report=await createCustomerAssessmentRunner({scanners:{...absentScanners,run},https:{lookup:async()=>[{address:'127.0.0.1',family:4}]}}).run(fixture);
    expect(run).not.toHaveBeenCalled();expect(report.internal).toBeNull();expect(report.external?.status).toBe('unavailable');expect(report.subject.targetVersion).toBe(3);
  });
});
describe('lockfile inventory and advisory adapter',()=>{
  const lock={lockfileVersion:3,packages:{'':{dependencies:{alpha:'^1.0.0'}},'node_modules/alpha':{version:'1.2.3'},'node_modules/alpha/node_modules/beta':{version:'2.0.0'},'node_modules/linked':{link:true},'node_modules/ranged':{version:'^3.0.0'}}};
  it.each([2,3])('extracts exact direct/transitive versions from v%s and preserves unknown entries',version=>{
    const source=input([{path:'package-lock.json',content:JSON.stringify({...lock,lockfileVersion:version})}]).source;if(!source)throw new Error();const parsed=parseLockfile(source);expect(parsed.inventory.map(p=>[p.name,p.version,p.relationship])).toEqual([['alpha','1.2.3','direct'],['beta','2.0.0','transitive']]);expect(parsed.unknownCount).toBe(2);expect(parsed.unknown).toContain('package-lock.json');
  });
  it('attributes fixture advisory matches without proving exploitation or severity',async()=>{
    const query=vi.fn(async(_packages: ReadonlyArray<{name:string;version:string}>)=>[{ids:['TEST-1'],complete:true},{ids:[],complete:true}]);
    const report=await createCustomerAssessmentRunner({scanners:absentScanners,advisory:{query}}).run(input([{path:'package-lock.json',content:JSON.stringify(lock)}]));
    expect(query.mock.calls[0]?.[0]).toEqual([{name:'alpha',version:'1.2.3'},{name:'beta',version:'2.0.0'}]);
    expect(report.internal?.findings[0]?.exploitability).toBe('unknown');expect(report.internal?.findings[0]?.severity).toBe('unknown');expect(report.comparison[0]?.classification).toBe('unverified');
  });
});
