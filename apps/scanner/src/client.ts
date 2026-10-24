import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { customerRunInputSchema, customerAssessmentReportSchema, type CustomerRunInput, type CustomerAssessmentReport } from '@gotchu/contracts';
import { assertReportBinding } from '@gotchu/customer-assessment';
import { checkSecret, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, signScannerBody } from './auth.js';
export interface ScannerClientOptions { origin:string;secret:Uint8Array;timeoutMs?:number;allowDevelopmentHttp?:boolean;now?:()=>number }
export function createScannerClient(options:ScannerClientOptions) {
  checkSecret(options.secret);const secret=Buffer.from(options.secret);const url=new URL(options.origin);
  const devHttp=options.allowDevelopmentHttp===true && ['development','test'].includes(process.env.NODE_ENV??'') && url.protocol==='http:' && (url.hostname==='127.0.0.1'||url.hostname==='[::1]');
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==options.origin||!(url.protocol==='https:'||devHttp))throw new Error('invalid_scanner_origin');
  const timeout=options.timeoutMs??60000;if(!Number.isInteger(timeout)||timeout<1||timeout>65000)throw new Error('invalid_timeout');
  return {async run(raw:CustomerRunInput):Promise<CustomerAssessmentReport>{
    const input=customerRunInputSchema.parse(raw);const bytes=Buffer.from(JSON.stringify(input));if(bytes.length>MAX_REQUEST_BYTES)throw new Error('request_limit');
    const timestamp=String(Math.floor((options.now?.()??Date.now())/1000));
    const response=await new Promise<Buffer>((resolve,reject)=>{
      const request=url.protocol==='https:'?httpsRequest:httpRequest;
      const req=request(new URL('/v1/assessments',url),{method:'POST',agent:false,rejectUnauthorized:true,signal:AbortSignal.timeout(timeout),maxHeaderSize:8192,headers:{'content-type':'application/json','content-length':bytes.length,'x-gotchu-timestamp':timestamp,'x-gotchu-signature':signScannerBody(secret,timestamp,bytes)}},res=>{
        if(res.statusCode!==200||res.headers['content-encoding']||res.headers['content-type']!=='application/json'){res.destroy();reject(new Error(`scanner_http_${res.statusCode??0}`));return;}
        let size=0;const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_RESPONSE_BYTES){res.destroy();reject(new Error('response_limit'));}else chunks.push(chunk);});
        res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(new Error('scanner_response_unavailable')));
      });
      req.on('error',()=>reject(new Error('scanner_transport_unavailable')));req.end(bytes);
    });
    const json:unknown=JSON.parse(response.toString('utf8'));const report=customerAssessmentReportSchema.parse(json);assertReportBinding(input,report);return report;
  }};
}
