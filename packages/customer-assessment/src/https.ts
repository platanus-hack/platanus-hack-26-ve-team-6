import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { customerOriginSchema } from '@gotchu/contracts';
import { bounded } from './common.js';

const excluded = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) excluded.addSubnet(address,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) excluded.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address: string) {
  if(address.includes('%')) return false;
  const family = isIP(address);
  return family === 4 ? !excluded.check(address,'ipv4') : family === 6 && global6.check(address,'ipv6') && !excluded.check(address,'ipv6');
}
export interface HttpsOptions {
  lookup?: (hostname: string) => Promise<Array<{address: string; family: number}>>;
  /** Only an explicitly scoped TLS fixture in NODE_ENV=test can connect to loopback. */
  testFixture?: { hostname: string; port: number; ca: string };
}
export interface HttpsObservation { status: number; headers: Record<string,string>; bodyBytes: number; tlsVerified: true; incomplete: string | null }
export function createHttpsProbe(options: HttpsOptions = {}) {
  const fixture = options.testFixture;
  if (fixture && (process.env.NODE_ENV !== 'test' || !options.lookup || !Number.isInteger(fixture.port) || fixture.port < 1024 || fixture.port > 65535)) throw new Error('invalid_test_fixture');
  return async (origin: string, parentSignal: AbortSignal, expiresAt?: string): Promise<HttpsObservation> => {
    const url = new URL(customerOriginSchema.parse(origin));
    const authorizedUntil = expiresAt === undefined ? Infinity : Date.parse(expiresAt);
    const remaining = authorizedUntil-Date.now();
    if (!(remaining > 0)) throw new Error('expired_target');
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.min(5000,remaining))]);
    const addresses = await bounded(()=>(options.lookup ?? (host => lookup(host,{all:true,verbatim:true})))(url.hostname),signal);
    // DNS can outlive authorization, including when a delayed event loop has not fired the timer.
    if (Date.now() >= authorizedUntil) throw new Error('expired_target');
    const scopedFixture = fixture?.hostname === url.hostname ? fixture : undefined;
    if (!addresses.length || addresses.length > 32 || addresses.some(a => isIP(a.address) !== a.family || !(isPublicAddress(a.address) || scopedFixture && (a.address === '127.0.0.1' || a.address === '::1')))) throw new Error('nonpublic_dns');
    const selected = addresses[0]; if (!selected) throw new Error('empty_dns');
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
      const req = request({ hostname: selected.address, family: selected.family, port: scopedFixture?.port ?? 443, servername: url.hostname, checkServerIdentity: (_host, certificate) => checkServerIdentity(url.hostname, certificate), rejectUnauthorized: true, ...(scopedFixture ? { ca: scopedFixture.ca } : {}), method:'GET', path:'/', agent:false, signal, maxHeaderSize:8192, headers:{host:url.hostname,accept:'text/html, application/json;q=0.8','accept-encoding':'identity','user-agent':'Gotchu-Observation/2'} }, res => {
        const status = res.statusCode ?? 0;
        const headers: Record<string,string> = {};
        for (const name of ['content-security-policy','strict-transport-security','x-content-type-options','x-frame-options','server','x-powered-by']) {
          const value = res.headers[name]; if (typeof value === 'string') headers[name] = value.slice(0,256).replace(/[\x00-\x1f\x7f]/g,'');
        }
        let bodyBytes = 0; let done = false;
        const onAbort=()=>complete('deadline_exceeded');
        const complete = (incomplete: string | null) => { if (done) return; done = true; signal.removeEventListener('abort',onAbort); resolve({status,headers,bodyBytes,tlsVerified:true,incomplete}); res.destroy(); req.destroy(); };
        if (status >= 300 && status < 400) { complete('redirect_refused'); return; }
        res.on('data',(chunk: Buffer) => { bodyBytes += chunk.length; if (bodyBytes > 16384) { bodyBytes = 16384; complete('body_limit'); } });
        res.on('end',() => complete(null));
        res.on('error',() => complete('response_interrupted'));
        signal.addEventListener('abort',onAbort,{once:true});
      });
      req.on('error',() => reject(new Error('https_unavailable'))); req.end();
    });
  };
}
