import { describe, expect, it } from 'vitest';
import { buildCorrelationInput,hasCorrelationEvidence } from './triage.js';

describe('triage input adapter',()=>{
  it('keeps absent feeds absent and omits a baseline without enough stored history',()=>{
    const now=new Date('2026-10-24T12:10:00.000Z');
    const input=buildCorrelationInput({now,observations:[{
      id:'observation-1',acceptedAt:'2026-10-24T12:09:00.000Z',body:{kind:'application_error',observedAt:'2026-10-24T12:08:00.000Z',metrics:{windowStartedAt:'2026-10-24T12:00:00.000Z',windowEndedAt:'2026-10-24T12:08:00.000Z',requestCount:20,errorCount:10,latencyP95Ms:900,capacityUtilization:null}},
    }]});
    expect(input.signals).toHaveLength(3);
    expect(input.signals.every(signal=>signal.environment==='application')).toBe(true);
    expect(input.baselines).toEqual([]);
    expect(input.providerStatuses).toEqual([]);
    expect(input.probes).toEqual([]);
    expect(input.context).toBeUndefined();
    expect(hasCorrelationEvidence(input)).toBe(true);
  });
  it('retains verified and declared context facts without upgrading declarations',()=>{
    const input=buildCorrelationInput({now:new Date('2026-10-24T12:00:00.000Z'),observations:[],context:{environment:'production',service:'api',deployments:[{service:'api',releaseId:'r2',commit:null,deployedAt:'2026-10-24T11:00:00.000Z',state:'declared'}],dependencies:[{service:'api',provider:'cloudflare',component:null,region:null,state:'declared'}]}});
    expect(input.context?.deployments[0]?.state).toBe('declared');
    expect(input.context?.dependencies[0]?.state).toBe('declared');
    expect(hasCorrelationEvidence(input)).toBe(false);
  });
  it('keeps provider scope and fixture metadata and labels authenticated metrics by service and environment',()=>{
    const now=new Date('2026-10-24T12:10:00.000Z');
    const metrics={windowStartedAt:'2026-10-24T12:00:00.000Z',windowEndedAt:'2026-10-24T12:08:00.000Z',requestCount:20,errorCount:10,latencyP95Ms:900,capacityUtilization:0.4};
    const input=buildCorrelationInput({now,observations:[{id:'current',acceptedAt:'2026-10-24T12:09:00.000Z',service:'checkout',environment:'production',release:'r-2',route:'/checkout',body:{kind:'application_error',observedAt:'2026-10-24T12:08:00.000Z',metrics}}],
      providerStatuses:[{provider:'cloudflare',component:'us-east',region:null,state:'partial_outage',observedAt:'2026-10-24T12:08:00.000Z',scope:'component',fixture:true}],
      probes:[{route:'/',service:'checkout',dependsOnProvider:'cloudflare',role:'application',outcome:'unavailable',at:'2026-10-24T12:08:00.000Z'}]});
    expect(input.signals[0]).toMatchObject({service:'checkout',environment:'production',id:expect.stringMatching(/^error_rate:/)});
    expect(input.providerStatuses).toEqual([expect.objectContaining({scope:'component',component:'us-east',fixture:true})]);
    expect(input.probes).toEqual([expect.objectContaining({route:'/',service:'checkout',dependsOnProvider:'cloudflare'})]);
    expect(input.baselines).toEqual([]);
  });
});
