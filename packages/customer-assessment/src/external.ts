import type { CustomerRunInput } from '@gotchu/contracts';
import { analysis, evidence, finding, finish, sha256 } from './common.js';
import { createHttpsProbe, type HttpsOptions } from './https.js';
import { deriveHttpResponseFindings } from './response-findings.js';
export async function assessExternal(input: CustomerRunInput, signal: AbortSignal, options: HttpsOptions = {}) {
  const target = input.target; if (!target) throw new Error('missing_target');
  const a = analysis('external',`target:${target.id}:${target.version}:${sha256(target.origin)}`);
  a.limitations.push('Only GET / was requested. No redirects, endpoint enumeration, credentials, exploitation, application version inference or source access.', 'Header presence does not establish policy effectiveness. A banner is untrusted and does not establish installed software or vulnerable versions.');
  try {
    if (Date.parse(target.expiresAt) <= Date.now() || Date.parse(target.verifiedAt) > Date.now()) throw new Error('expired_target');
    const observed = await createHttpsProbe(options)(target.origin,signal,target.expiresAt);
    const id = evidence(a,'http_response',`${target.origin}/`,observed,{name:'node:https',version:process.versions.node});
    a.coverage.push({capability:'tls_https',state:'inspected',detail:'A real TLS connection verified the certificate chain and enrolled hostname against the selected validated DNS address.'});
    a.coverage.push({capability:'root_headers',state:observed.incomplete ? 'unavailable' : 'inspected',detail:observed.incomplete ?? `Observed HTTP ${observed.status}; headers apply only to this response.`});
    for (const item of deriveHttpResponseFindings({
      location:`${target.origin}/`,status:observed.status,headers:observed.headers,tlsVerified:observed.tlsVerified,incomplete:observed.incomplete,evidenceId:id,
    })) finding(a,item);
  } catch { a.coverage.push({capability:'public_https_root',state:'unavailable',detail:'The authorized public HTTPS operation could not complete within the DNS, TLS, scope or time bounds.'}); }
  a.coverage.push({capability:'application_versions_and_exploitability',state:'unsupported',detail:'No verified package inventory, reachability or exploitation coverage from the public response.'});
  return finish(a);
}
