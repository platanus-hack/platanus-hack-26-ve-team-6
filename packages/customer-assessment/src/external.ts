import type { CustomerRunInput } from '@gotchu/contracts';
import { analysis, evidence, finding, finish, sha256 } from './common.js';
import { createHttpsProbe, type HttpsOptions } from './https.js';
export async function assessExternal(input: CustomerRunInput, signal: AbortSignal, options: HttpsOptions = {}) {
  const target = input.target; if (!target) throw new Error('missing_target');
  const a = analysis('external',`target:${target.id}:${target.version}:${sha256(target.origin)}`);
  a.limitations.push('Only GET / was requested. No redirects, endpoint enumeration, credentials, exploitation, application version inference or source access.', 'Header presence does not establish policy effectiveness. A banner is untrusted and does not establish installed software or vulnerable versions.');
  try {
    if (Date.parse(target.expiresAt) <= Date.now() || Date.parse(target.verifiedAt) > Date.now()) throw new Error('expired_target');
    const observed = await createHttpsProbe(options)(target.origin,signal);
    const id = evidence(a,'http_response',`${target.origin}/`,observed,{name:'node:https',version:process.versions.node});
    a.coverage.push({capability:'tls_https',state:'inspected',detail:'A real TLS connection verified the certificate chain and enrolled hostname against the selected validated DNS address.'});
    a.coverage.push({capability:'root_headers',state:observed.incomplete ? 'unavailable' : 'inspected',detail:observed.incomplete ?? `Observed HTTP ${observed.status}; headers apply only to this response.`});
    if (!observed.incomplete) {
      for (const header of ['content-security-policy','strict-transport-security','x-content-type-options']) if (!observed.headers[header]) finding(a,{
        ruleId:`https.missing-${header}`,correlationKey:`http:${header}`,title:`Response omits ${header}`,location:`${target.origin}/`,description:`The observed HTTP ${observed.status} root response did not include ${header}.`,severity:'low',confidence:'observed',impact:'Browser hardening may be reduced for this response.',recommendation:'Review the appropriate response policy and apply it where relevant.',limitations:['No other response or route was checked; no exploit was attempted.'],evidenceIds:[id],
      });
      if (observed.headers['server'] || observed.headers['x-powered-by']) finding(a,{ruleId:'https.technology-banner',correlationKey:'http:technology-banner',title:'Response advertises a technology banner',location:`${target.origin}/`,description:'The server supplied a banner. Its software identity and version are unverified.',severity:'informational',confidence:'inferred',impact:'The response exposes an unverified technology indication.',recommendation:'Review whether the banner is necessary.',limitations:['Do not treat a banner as inventory, a package advisory match, or proof of exploitation.'],evidenceIds:[id]});
    }
  } catch { a.coverage.push({capability:'public_https_root',state:'unavailable',detail:'The authorized public HTTPS operation could not complete within the DNS, TLS, scope or time bounds.'}); }
  a.coverage.push({capability:'application_versions_and_exploitability',state:'unsupported',detail:'No verified package inventory, reachability or exploitation coverage from the public response.'});
  return finish(a);
}
