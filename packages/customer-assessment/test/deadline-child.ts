// Runs in a separate Node process with strict unhandled-rejection handling.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded } from '../src/common.js';
import { createCustomerAssessmentRunner, createOsvAdapter } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

await assert.rejects(bounded(Promise.reject(new Error('already_started')),AbortSignal.abort()));
let started=false;
await assert.rejects(bounded(async()=>{started=true;},AbortSignal.abort()));
assert.equal(started,false);
const osv=createOsvAdapter();let queries=0;
const runner=createCustomerAssessmentRunner({deadlineMs:10,scanners:{...absentScanners,async run(_name,_source,signal){
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  await delay(15);throw new Error('aborted');
}},advisory:{query(packages,signal){queries++;return osv.query(packages,signal);}}});
// AbortSignal.timeout is unref'ed; model the live scanner server's owned handle.
const keepAlive=setInterval(()=>{},1000);
try {
  const report=await runner.run(input([{path:'package-lock.json',content:JSON.stringify({lockfileVersion:3,packages:{'node_modules/lodash':{version:'4.17.20'}}})}]));
  assert.equal(queries,0);
  assert.equal(report.internal?.coverage.find(c=>c.capability==='npm_advisories')?.state,'unavailable');
} finally { clearInterval(keepAlive); }
await delay(50);
console.log('deadline-regression-ok');
