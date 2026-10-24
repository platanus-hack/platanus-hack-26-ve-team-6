import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { customerAssessmentReportSchema, customerRunInputSchema, type CustomerRunInput, type CustomerAssessmentReport } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, assertReportBinding } from '@gotchu/customer-assessment';
import { checkSecret, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, verifyScannerSignature } from './auth.js';
export interface ScannerRunner {
  run(input: CustomerRunInput): Promise<CustomerAssessmentReport>;
  readiness(): Promise<{ready:boolean;tools:Array<{name:string;available:boolean}>}>;
}
function send(response: ServerResponse, status: number, value: unknown) { if(!response.destroyed) response.writeHead(status,{'content-type':'application/json','cache-control':'no-store','connection':'close'}).end(JSON.stringify(value)); }
async function body(request: IncomingMessage) {
  const chunks: Buffer[]=[]; let size=0;
  const timer=setTimeout(()=>request.destroy(),5000);
  try {for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>MAX_REQUEST_BYTES) throw new Error('body_limit');chunks.push(bytes);}return Buffer.concat(chunks);}finally{clearTimeout(timer);}
}
export function createScannerServer(options: {secret:Uint8Array;runner?:ScannerRunner}) {
  checkSecret(options.secret); const secret=Buffer.from(options.secret); const runner=options.runner??createCustomerAssessmentRunner();
  const used=new Map<string,number>(); let active=false;
  async function handle(req: IncomingMessage,res: ServerResponse) {
    if(req.url === '/readyz' && req.method === 'GET') {const state=await runner.readiness();send(res,state.ready?200:503,state);return;}
    if(req.url !== '/v1/assessments' || req.method !== 'POST'){send(res,404,{error:'not_found'});return;}
    const timestamp=req.headers['x-gotchu-timestamp'];const signature=req.headers['x-gotchu-signature'];
    if(typeof timestamp!=='string'||typeof signature!=='string'||req.headers['content-type']!=='application/json'||req.headers['content-encoding']||Number(req.headers['content-length']??0)>MAX_REQUEST_BYTES){send(res,400,{error:'invalid_request'});return;}
    if(active){send(res,429,{error:'scanner_busy'});return;}
    active=true; let workOwnsSlot=false;
    try {
      const bytes=await body(req);
      if(!verifyScannerSignature(secret,timestamp,signature,bytes)){send(res,401,{error:'invalid_signature'});return;}
      const now=Date.now();for(const [key,expires] of used)if(expires<now)used.delete(key);
      if(used.has(signature)){send(res,409,{error:'replay'});return;}
      if(used.size>=1000){send(res,429,{error:'replay_capacity'});return;}
      used.set(signature,(Number(timestamp)+61)*1000);
      let json: unknown;try{json=JSON.parse(bytes.toString('utf8'));}catch{send(res,400,{error:'invalid_json'});return;}
      const parsed=customerRunInputSchema.safeParse(json);
      if(!parsed.success){send(res,400,{error:'invalid_input'});return;}
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work=runner.run(parsed.data); workOwnsSlot=true;
      // A timed-out injected runner keeps admission closed until it actually settles.
      work.then(()=>{active=false;},()=>{active=false;});
      try {
        const result=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('runner_timeout')),60000);})]);
        const report=customerAssessmentReportSchema.parse(result);assertReportBinding(parsed.data,report);
        if(Buffer.byteLength(JSON.stringify(report))>MAX_RESPONSE_BYTES)throw new Error('report_limit');
        send(res,200,report);
      } finally {if(timer)clearTimeout(timer);}
    } catch {send(res,503,{error:'assessment_unavailable'});}
    finally {if(!workOwnsSlot)active=false;}
  }
  const server=createServer({maxHeaderSize:8192,requestTimeout:70000,headersTimeout:5000,keepAliveTimeout:1000},(req,res)=>{
    handle(req,res).catch(()=>send(res,503,{error:'scanner_unavailable'}));
  });
  server.maxConnections=16;
  return server;
}
