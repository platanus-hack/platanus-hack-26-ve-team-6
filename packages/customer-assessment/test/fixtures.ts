import { randomUUID } from 'node:crypto';
import type { CustomerRunInput } from '@gotchu/contracts';
import { sourceDigest } from '../src/index.js';
export function input(files = [{path:'app.ts',content:'export const twice = (x: number) => x * 2;'}]): CustomerRunInput {
  const snapshot={revision:'customer-sha-arbitrary',files};
  return {version:2,organizationId:randomUUID(),applicationId:randomUUID(),jobId:randomUUID(),applicationName:'Customer application',mode:'internal',source:{...snapshot,id:randomUUID(),digest:sourceDigest(snapshot)},target:null};
}
export const absentScanners = {async run():Promise<never>{throw new Error('unavailable');},async readiness(){return {ready:false,tools:[{name:'fixtures-unavailable',available:false}]};}};
