import { z } from 'zod';
import type { AssessmentAnalysis, AssessmentFinding, CustomerRunInput } from '@gotchu/contracts';
import { analysis, bounded, isScannerCleanupError, evidence, finding, finish } from './common.js';
import type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
import { parseLockfile, type AdvisoryAdapter } from './advisory.js';

const position = z.object({line:z.number().int().positive()});
const semgrepSchema = z.object({version:z.string(),results:z.array(z.object({check_id:z.string().max(128),path:z.string().max(1024),start:position})).max(2000),errors:z.array(z.unknown()),paths:z.object({scanned:z.array(z.string())})});
const leaksSchema = z.array(z.object({RuleID:z.string().max(128),File:z.string().max(1024),StartLine:z.number().int().positive()})).max(2000);
const trivySchema = z.object({SchemaVersion:z.number(),Results:z.array(z.object({Target:z.string().max(1024),Misconfigurations:z.array(z.object({ID:z.string().max(128),AVDID:z.string().max(128),Title:z.string().min(1).max(256),Description:z.string().min(1).max(4000),Resolution:z.string().min(1).max(4000),Severity:z.enum(['UNKNOWN','LOW','MEDIUM','HIGH','CRITICAL']),CauseMetadata:z.object({StartLine:z.number().int().nonnegative().optional()}).optional()})).optional()})).optional()});
interface Indicator { rule: string; path: string; line: number; severity: AssessmentFinding['severity']; title?:string; description?:string; recommendation?:string }
function normalize(name: ScannerName, result: ToolResult): {indicators:Indicator[]; incomplete:boolean; scanned:number} {
  if (name === 'semgrep') {
    const parsed = semgrepSchema.parse(result.output);
    if (parsed.version !== result.version) throw new Error('scanner_version_mismatch');
    return {indicators:parsed.results.map(r=>({rule:r.check_id,path:r.path,line:r.start.line,severity:'medium'})),incomplete:parsed.errors.length>0,scanned:parsed.paths.scanned.length};
  }
  if (name === 'gitleaks') return {indicators:leaksSchema.parse(result.output).map(r=>({rule:r.RuleID,path:r.File,line:r.StartLine,severity:'high'})),incomplete:false,scanned:0};
  const parsed = trivySchema.parse(result.output);
  const severities={UNKNOWN:'informational',LOW:'low',MEDIUM:'medium',HIGH:'high',CRITICAL:'critical'} as const;
  return {indicators:(parsed.Results??[]).flatMap(r=>(r.Misconfigurations??[]).map(m=>({rule:m.AVDID,path:r.Target,line:m.CauseMetadata?.StartLine??0,severity:severities[m.Severity],title:m.Title,description:m.Description,recommendation:m.Resolution}))),incomplete:false,scanned:parsed.Results?.length??0};
}
function addTool(a: AssessmentAnalysis, name: ScannerName, result: ToolResult, source: NonNullable<CustomerRunInput['source']>) {
  const parsed = normalize(name,result);
  if(name === 'semgrep' && parsed.scanned < source.files.filter(f=>/\.[cm]?[jt]sx?$/i.test(f.path)).length) parsed.incomplete=true;
  const provenance = {image:result.image,profileChecksum:result.profileChecksum,sourceDigest:source.digest,redacted:true,matched:parsed.indicators.length,scanned:parsed.scanned};
  const tool = {name,version:result.version};
  evidence(a,'configuration',`scanner-profile:${name}`,provenance,tool);
  let truncated = false;
  for (const hit of parsed.indicators) {
    if (a.findings.length >= 75 || a.evidence.length >= 150) {truncated=true;break;}
    const path = hit.path.replace(/^\/?source\//,'');
    const file = source.files.find(f=>f.path === path);
    if (!file) throw new Error('scanner_unknown_path');
    const location = `${path}:${hit.line}`;
    const id = evidence(a,name === 'gitleaks' ? 'source' : name === 'trivy' ? 'configuration':'source',location,{rule:hit.rule,path,line:hit.line,content:'[REDACTED]',sourceDigest:source.digest},tool);
    finding(a,{ruleId:hit.rule,correlationKey:`${name}:${hit.rule}:${path}`.slice(0,512),title:hit.title ?? `${name} static indicator: ${hit.rule}`.slice(0,256),location,description:hit.description ?? `The controlled ${name} profile matched a static indicator in the uploaded bytes. The source excerpt and any secret value are redacted.`,severity:hit.severity,confidence:'inferred',impact:name === 'gitleaks' ? 'Potential credential material may be exposed; validity and use are unknown.':'The matched source or configuration may weaken a security boundary; runtime reachability is unknown.',recommendation:hit.recommendation ?? (name === 'gitleaks' ? 'Review privately; revoke and rotate if this is a real credential.':'Review the indicated location and trust boundary, then rescan the updated snapshot.'),limitations:['Static rule match only; no customer code or exploit was executed.'],evidenceIds:[id]});
  }
  if(name === 'trivy' && parsed.scanned===0) {
    a.coverage.push({capability:name,state:'unsupported',detail:'The pinned Kubernetes profile recognized no supported configuration in this snapshot.'});
    return;
  }
  a.coverage.push({capability:name,state:parsed.incomplete || truncated ? 'unavailable':'inspected',detail:parsed.incomplete ? 'Scanner reported parsing or analysis errors; findings retain only available evidence.' : truncated ? 'Finding cap reached; additional matches were omitted.' : `Completed pinned ${name} profile against uploaded files only; no finding is not proof of safety.`});
}
export async function assessInternal(input: CustomerRunInput, signal: AbortSignal, scanners: ScannerAdapter, advisory?: AdvisoryAdapter) {
  const source = input.source; if (!source) throw new Error('missing_source');
  const a = analysis('internal',`source:${source.id}:sha256:${source.digest}`);
  a.limitations.push('Static analysis only. Customer code, imports, build tools, package scripts and tests never execute.', 'Semgrep checks eval, selected child_process exec calls and disabled TLS verification. Gitleaks checks three controlled secret patterns. Trivy inspects Kubernetes configuration with image-bundled rules.', 'Package-lock metadata is not proof of installed/deployed packages, reachability, exploitation or compromise. No provider changes or remediation occur.');
  const names: ScannerName[] = ['semgrep','gitleaks','trivy'];
  const results = await Promise.allSettled(names.map(name=>bounded(()=>scanners.run(name,source,signal),signal)));
  for (let i=0;i<names.length;i++) {
    const name = names[i]; const result = results[i]; if (!name || !result) continue;
    const beforeEvidence = a.evidence.length; const beforeFindings = a.findings.length;
    try { if(result.status === 'rejected') throw result.reason; addTool(a,name,result.value,source); }
    catch (error) { if (isScannerCleanupError(error)) throw error; a.evidence.length=beforeEvidence; a.findings.length=beforeFindings; a.coverage.push({capability:name,state:'unavailable',detail:'Pinned scanner unavailable, malformed output, resource/deadline exceeded or invalid source mapping. No clean result inferred.'}); }
  }
  const locked = parseLockfile(source);
  if (!locked.found) a.coverage.push({capability:'npm_lockfile',state:'unavailable',detail:'No package-lock v2/v3 was uploaded. Package declarations and banners are not substituted for exact resolved versions.'});
  else {
    a.coverage.push({capability:'npm_lockfile',state:locked.unknown.length ? 'unavailable':'inspected',detail:`Resolved ${locked.inventory.length} direct/transitive exact package versions; ${locked.unknown.length} unsupported or capped entries. Yarn, pnpm, aliases, links and installed state are outside this profile.`});
    try {
      if (!advisory) throw new Error('advisory_unconfigured');
      const matches = await bounded(()=>advisory.query(locked.inventory.map(({name,version})=>({name,version})),signal),signal);
      if (matches.length !== locked.inventory.length) throw new Error('advisory_count');
      let incomplete = matches.some(m=>!m.complete);
      for (let i=0;i<matches.length;i++) {
        const match = matches[i]; const pkg = locked.inventory[i]; if(!match || !pkg) continue;
        for (const id of match.ids) {
          if(a.findings.length>=100 || a.evidence.length>=200){incomplete=true;break;}
          const evidenceId = evidence(a,'advisory',`osv:${id}`,{id,package:pkg,sourceDigest:source.digest,queriedAt:new Date().toISOString()},{name:'OSV-querybatch',version:'v1'});
          finding(a,{ruleId:`osv.${id}`.slice(0,128),correlationKey:`npm:${pkg.name}:${id}`,title:`Advisory match: ${pkg.name}@${pkg.version}`.slice(0,256),location:pkg.location,description:`The exact ${pkg.relationship} lockfile version matched ${id} in the configured OSV-compatible adapter. Advisory severity was not fetched.`,severity:'informational',confidence:'observed',impact:'An advisory applies to the recorded version; installed state, reachability and exploitability remain unknown.',recommendation:'Review the advisory and dependency path, choose a supported fix and validate the application.',limitations:['Severity is unassessed; informational is not a low-risk determination.', 'No package installation, package source upload or exploit attempt.'],evidenceIds:[evidenceId]});
        }
      }
      a.coverage.push({capability:'npm_advisories',state:incomplete?'unavailable':'inspected',detail:incomplete?'Advisory results were paginated or capped; remaining matches are unknown.':'Bounded exact-version advisory queries completed at the evidence collection time.'});
    } catch {a.coverage.push({capability:'npm_advisories',state:'unavailable',detail:'Optional advisory adapter missing, failed or exceeded the deadline. No clean dependency claim.'});}
  }
  return finish(a);
}
