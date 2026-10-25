import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { customerRunInputSchema, customerAssessmentReportSchema, customerScannerProgressSchema, type CustomerRunInput, type CustomerAssessmentReport, type CustomerScannerPhase } from '@gotchu/contracts';
import { assertReportBinding } from '@gotchu/customer-assessment';
import { checkSecret, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, SCANNER_PROGRESS_TYPE, signScannerBody } from './auth.js';
export const MAX_SCANNER_CA_BYTES = 256 * 1024;
// A few short progress lines may precede the report.
const MAX_PROGRESS_BYTES = 4096;
function parseLine(line: Buffer): unknown {
  try { return JSON.parse(line.toString('utf8')); } catch { return undefined; }
}

export interface ScannerClientOptions { origin:string;secret:Uint8Array;ca?:Uint8Array;timeoutMs?:number;allowDevelopmentHttp?:boolean;now?:()=>number }

export function validateScannerCa(raw: Uint8Array): Buffer {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > MAX_SCANNER_CA_BYTES) throw new Error('invalid_scanner_ca');
  const ca = Buffer.from(raw);
  for (const byte of ca) if (byte > 0x7f) throw new Error('invalid_scanner_ca');
  try {
    const pem = ca.toString('ascii');
    const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certificates = pem.match(certificatePattern) ?? [];
    if (certificates.length === 0 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim() !== '') throw new Error('invalid_scanner_ca');
    const canonicalCertificates = certificates.map(certificate => {
      const x509 = new X509Certificate(certificate);
      if (!x509.ca) throw new Error('invalid_scanner_ca');
      return x509.toString().trim();
    });
    const canonicalCa = Buffer.from(canonicalCertificates.join('\n'), 'ascii');
    if (canonicalCa.length === 0 || canonicalCa.length > MAX_SCANNER_CA_BYTES) throw new Error('invalid_scanner_ca');
    createSecureContext({ ca: canonicalCa });
    return canonicalCa;
  }
  catch { throw new Error('invalid_scanner_ca'); }
}

export function createScannerClient(options:ScannerClientOptions) {
  checkSecret(options.secret);const secret=Buffer.from(options.secret);const url=new URL(options.origin);
  const devHttp=options.allowDevelopmentHttp===true && ['development','test'].includes(process.env.NODE_ENV??'') && url.protocol==='http:' && (url.hostname==='127.0.0.1'||url.hostname==='[::1]');
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==options.origin||!(url.protocol==='https:'||devHttp))throw new Error('invalid_scanner_origin');
  const ca = options.ca === undefined ? undefined : validateScannerCa(options.ca);
  if (ca && url.protocol !== 'https:') throw new Error('scanner_ca_requires_https');
  const timeout=options.timeoutMs??60000;if(!Number.isInteger(timeout)||timeout<1||timeout>65000)throw new Error('invalid_timeout');
  return {async run(raw:CustomerRunInput,run:{onProgress?:(phase:CustomerScannerPhase)=>void}={}):Promise<CustomerAssessmentReport>{
    const input=customerRunInputSchema.parse(raw);const bytes=Buffer.from(JSON.stringify(input));if(bytes.length>MAX_REQUEST_BYTES)throw new Error('request_limit');
    const timestamp=String(Math.floor((options.now?.()??Date.now())/1000));
    const response=await new Promise<Buffer>((resolve,reject)=>{
      const request=url.protocol==='https:'?httpsRequest:httpRequest;
      const accept=run.onProgress?SCANNER_PROGRESS_TYPE:'application/json';
      const req=request(new URL('/v1/assessments',url),{method:'POST',agent:false,rejectUnauthorized:true,...(ca ? {ca} : {}),signal:AbortSignal.timeout(timeout),maxHeaderSize:8192,headers:{'content-type':'application/json','accept':accept,'content-length':bytes.length,'x-gotchu-timestamp':timestamp,'x-gotchu-signature':signScannerBody(secret,timestamp,bytes)}},res=>{
        const type=res.headers['content-type'];
        if(res.statusCode!==200||res.headers['content-encoding']||(type!=='application/json'&&type!==accept)){res.destroy();reject(new Error(`scanner_http_${res.statusCode??0}`));return;}
        const streaming=type===SCANNER_PROGRESS_TYPE;
        let size=0;let pending:Buffer[]=[];const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{
          size+=chunk.length;if(size>MAX_RESPONSE_BYTES+(streaming?MAX_PROGRESS_BYTES:0)){res.destroy();reject(new Error('response_limit'));return;}
          if(!streaming){chunks.push(chunk);return;}
          // Progress lines are reported as they arrive; the last line carries the report.
          let start=0;
          for(let end=chunk.indexOf(10);end!==-1;end=chunk.indexOf(10,start)){
            const line=Buffer.concat([...pending,chunk.subarray(start,end)]);pending=[];start=end+1;
            const progress=line.length<=256?customerScannerProgressSchema.safeParse(parseLine(line)):undefined;
            if(progress?.success)run.onProgress?.(progress.data.phase);else chunks.push(line);
          }
          if(start<chunk.length)pending.push(chunk.subarray(start));
        });
        res.on('end',()=>{
          if(!streaming){resolve(Buffer.concat(chunks));return;}
          const last=chunks.length===1&&pending.length===0?parseLine(chunks[0]??Buffer.alloc(0)):undefined;
          if(last&&typeof last==='object'&&'type' in last&&last.type==='report'&&'report' in last)resolve(Buffer.from(JSON.stringify(last.report)));
          else reject(new Error('scanner_assessment_unavailable'));
        });
        res.on('error',()=>reject(new Error('scanner_response_unavailable')));
      });
      req.on('error',()=>reject(new Error('scanner_transport_unavailable')));req.end(bytes);
    });
    const json:unknown=JSON.parse(response.toString('utf8'));const report=customerAssessmentReportSchema.parse(json);assertReportBinding(input,report);return report;
  }};
}
