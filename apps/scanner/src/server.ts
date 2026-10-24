import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { customerAssessmentReportSchema, customerRunInputSchema, type CustomerRunInput, type CustomerAssessmentReport } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, assertReportBinding, isScannerCleanupError } from '@gotchu/customer-assessment';
import { checkSecret, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, verifyScannerSignature } from './auth.js';
export interface ScannerRunner {
  run(input: CustomerRunInput): Promise<CustomerAssessmentReport>;
  readiness(): Promise<{ready:boolean;tools:Array<{name:string;available:boolean}>}>;
}
export interface ScannerTlsIdentity { cert: Uint8Array; key: Uint8Array }
function send(response: ServerResponse, status: number, value: unknown) { if(!response.destroyed) response.writeHead(status,{'content-type':'application/json','cache-control':'no-store','connection':'close'}).end(JSON.stringify(value)); }
async function body(request: IncomingMessage) {
  const chunks: Buffer[]=[]; let size=0;
  const timer=setTimeout(()=>request.destroy(),30000);
  try {for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>MAX_REQUEST_BYTES) throw new Error('body_limit');chunks.push(bytes);}return Buffer.concat(chunks);}finally{clearTimeout(timer);}
}
async function responseWithin<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('runner_timeout')),milliseconds);})]);
  } finally { if(timer) clearTimeout(timer); }
}
export function createScannerServer(options: {secret:Uint8Array;runner?:ScannerRunner;now?:()=>number;tls?:ScannerTlsIdentity}) {
  checkSecret(options.secret); const secret=Buffer.from(options.secret); const runner=options.runner??createCustomerAssessmentRunner();
  const tls = options.tls ? { cert: Buffer.from(options.tls.cert), key: Buffer.from(options.tls.key) } : undefined;
  if (tls) {
    try { createSecureContext({ ...tls, minVersion: 'TLSv1.2' }); }
    catch { throw new Error('invalid_scanner_tls_identity'); }
  }
  const now=options.now??Date.now;
  const used=new Map<string,number>(); let active=false; let fault=false;
  type Readiness = Awaited<ReturnType<ScannerRunner['readiness']>>;
  let readinessCache: {until:number;state:Readiness} | undefined;
  let readinessResponse: Promise<Readiness> | undefined;
  const unavailable: Readiness = {ready:false,tools:[]};
  function release(error?: unknown) {
    if (isScannerCleanupError(error)) fault=true;
    if (error) readinessCache=undefined;
    active=false;
  }
  function readiness(): Promise<Readiness> {
    if(fault) return Promise.resolve(unavailable);
    if(readinessResponse) return readinessResponse;
    if(active) return Promise.resolve(unavailable);
    if(readinessCache && readinessCache.until>now()) return Promise.resolve(readinessCache.state);
    active=true;
    const work=Promise.resolve().then(()=>runner.readiness());
    // The response can time out, but only settlement of the underlying probe frees admission.
    work.then(state=>{readinessCache={until:now()+30000,state};readinessResponse=undefined;release();},error=>{readinessResponse=undefined;release(error);});
    readinessResponse=responseWithin(work,40000).catch(()=>unavailable);
    return readinessResponse;
  }
  async function handle(req: IncomingMessage,res: ServerResponse) {
    if(req.url === '/readyz' && req.method === 'GET') {const state=await readiness();send(res,state.ready?200:503,state);return;}
    if(req.url !== '/v1/assessments' || req.method !== 'POST'){send(res,404,{error:'not_found'});return;}
    const timestamp=req.headers['x-gotchu-timestamp'];const signature=req.headers['x-gotchu-signature'];
    if(typeof timestamp!=='string'||typeof signature!=='string'||req.headers['content-type']!=='application/json'||req.headers['content-encoding']||Number(req.headers['content-length']??0)>MAX_REQUEST_BYTES){send(res,400,{error:'invalid_request'});return;}
    if(fault){send(res,503,{error:'scanner_unavailable'});return;}
    if(active){send(res,429,{error:'scanner_busy'});return;}
    active=true; let workOwnsSlot=false;
    try {
      const bytes=await body(req);
      const receivedAt=now();
      if(!verifyScannerSignature(secret,timestamp,signature,bytes,receivedAt)){send(res,401,{error:'invalid_signature'});return;}
      for(const [key,expires] of used)if(expires<receivedAt)used.delete(key);
      if(used.has(signature)){send(res,409,{error:'replay'});return;}
      if(used.size>=1000){send(res,429,{error:'replay_capacity'});return;}
      used.set(signature,(Number(timestamp)+61)*1000);
      let json: unknown;try{json=JSON.parse(bytes.toString('utf8'));}catch{send(res,400,{error:'invalid_json'});return;}
      const parsed=customerRunInputSchema.safeParse(json);
      if(!parsed.success){send(res,400,{error:'invalid_input'});return;}
      const work=Promise.resolve().then(()=>runner.run(parsed.data)); workOwnsSlot=true;
      work.then(()=>release(),error=>release(error));
      const result=await responseWithin(work,55000);
      const report=customerAssessmentReportSchema.parse(result);assertReportBinding(parsed.data,report);
      if(Buffer.byteLength(JSON.stringify(report))>MAX_RESPONSE_BYTES)throw new Error('report_limit');
      send(res,200,report);
    } catch {send(res,503,{error:'assessment_unavailable'});}
    finally {if(!workOwnsSlot)active=false;}
  }
  const handleRequest = (req:IncomingMessage,res:ServerResponse)=>{
    handle(req,res).catch(()=>send(res,503,{error:'scanner_unavailable'}));
  };
  const server=tls
    ? createHttpsServer({ ...tls, minVersion:'TLSv1.2', maxHeaderSize:8192, requestTimeout:70000, headersTimeout:5000, keepAliveTimeout:1000 },handleRequest)
    : createServer({maxHeaderSize:8192,requestTimeout:70000,headersTimeout:5000,keepAliveTimeout:1000},handleRequest);
  server.maxConnections=16;
  return server;
}
