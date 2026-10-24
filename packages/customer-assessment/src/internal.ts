import { z } from 'zod';
import type { AssessmentAnalysis, AssessmentFinding, CustomerRunInput } from '@gotchu/contracts';
import { analysis, bounded, isScannerCleanupError, evidence, finding, finish } from './common.js';
import type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
import { parseLockfile, type AdvisoryAdapter } from './advisory.js';
import { createHelmetCspGate, HELMET_CSP_GATE_VERSION, isHelmetCspCandidateRule, HELMET_CSP_TYPESCRIPT_VERSION } from './helmet-csp-gate.js';
import { classifyKubernetesCandidate, findKubernetesCorrectionLocation } from './kubernetes.js';

const position = z.object({line:z.number().int().positive()});
const semgrepPosition = position.extend({offset:z.number().int().nonnegative().optional(),col:z.number().int().positive().optional()});
const semgrepSchema = z.object({version:z.string(),results:z.array(z.object({check_id:z.string().max(128),path:z.string().max(1024),start:semgrepPosition,extra:z.object({severity:z.string().optional(),metadata:z.record(z.string(),z.unknown()).optional()}).optional()})).max(2000),errors:z.array(z.unknown()),paths:z.object({scanned:z.array(z.string())})});
const leaksSchema = z.array(z.object({RuleID:z.string().max(128),File:z.string().max(1024),StartLine:z.number().int().positive()})).max(2000);
const trivySchema = z.object({SchemaVersion:z.number(),Results:z.array(z.object({Target:z.string().max(1024),Misconfigurations:z.array(z.object({ID:z.string().max(128),AVDID:z.string().max(128),Title:z.string().min(1).max(256),Description:z.string().min(1).max(4000),Resolution:z.string().min(1).max(4000),Severity:z.enum(['UNKNOWN','LOW','MEDIUM','HIGH','CRITICAL']),CauseMetadata:z.object({StartLine:z.number().int().nonnegative().optional(),EndLine:z.number().int().nonnegative().optional()}).optional()})).optional()})).optional()});
interface Indicator { rule: string; path: string; line: number; checkId?:string; causeStartLine?:number; causeEndLine?:number; correctionLocationLine?:number; offset?:number; col?:number; severity: AssessmentFinding['severity']; title?:string; description?:string; recommendation?:string; cwe?:string; owasp?:string; precisionNote?:string }
function metadataText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 512);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(', ').slice(0, 512);
  return undefined;
}
function semgrepSeverity(value: string | undefined): AssessmentFinding['severity'] {
  switch (value?.toUpperCase()) {
    case 'INFO': case 'INVENTORY': return 'informational';
    case 'WARNING': case 'MEDIUM': return 'medium';
    case 'ERROR': case 'HIGH': case 'CRITICAL': return value.toUpperCase() === 'CRITICAL' ? 'critical' : 'high';
    case 'LOW': return 'low';
    default: return 'unknown';
  }
}
function normalize(name: ScannerName, result: ToolResult): {indicators:Indicator[]; incomplete:boolean; scanned:number; scannedPaths?:string[]} {
  if (name === 'semgrep') {
    const parsed = semgrepSchema.parse(result.output);
    if (parsed.version !== result.version) throw new Error('scanner_version_mismatch');
    return {indicators:parsed.results.map(r=>{
      const cwe = metadataText(r.extra?.metadata?.cwe);
      const owasp = metadataText(r.extra?.metadata?.owasp);
      const precisionNote = metadataText(r.extra?.metadata?.precision_note);
      return {
        rule:r.check_id,path:r.path,line:r.start.line,...(r.start.offset === undefined ? {} : {offset:r.start.offset}),...(r.start.col === undefined ? {} : {col:r.start.col}),
        severity:semgrepSeverity(r.extra?.severity), ...(cwe ? {cwe} : {}), ...(owasp ? {owasp} : {}), ...(precisionNote ? {precisionNote} : {}),
      };
    }),incomplete:parsed.errors.length>0,scanned:parsed.paths.scanned.length};
  }
  if (name === 'gitleaks') return {indicators:leaksSchema.parse(result.output).map(r=>({rule:r.RuleID,path:r.File,line:r.StartLine,severity:'high'})),incomplete:false,scanned:0};
  const parsed = trivySchema.parse(result.output);
  const severities={UNKNOWN:'unknown',LOW:'low',MEDIUM:'medium',HIGH:'high',CRITICAL:'critical'} as const;
  return {indicators:(parsed.Results??[]).flatMap(r=>(r.Misconfigurations??[]).map(m=>({rule:m.AVDID,path:r.Target,line:m.CauseMetadata?.StartLine??0,checkId:m.ID,...(m.CauseMetadata?.StartLine === undefined ? {} : {causeStartLine:m.CauseMetadata.StartLine}),...(m.CauseMetadata?.EndLine === undefined ? {} : {causeEndLine:m.CauseMetadata.EndLine}),severity:severities[m.Severity],title:m.Title,description:m.Description,recommendation:m.Resolution}))),incomplete:false,scanned:parsed.Results?.length??0,scannedPaths:(parsed.Results??[]).map(r=>r.Target)};
}
function addTool(a: AssessmentAnalysis, name: ScannerName, result: ToolResult, source: NonNullable<CustomerRunInput['source']>) {
  const parsed = normalize(name,result);
  if(name === 'semgrep' && parsed.scanned < source.files.filter(f=>/\.(?:[cm]?[jt]sx?|py|go|java)$/i.test(f.path)).length) parsed.incomplete=true;
  const helmetCspGate = name === 'semgrep' ? createHelmetCspGate(source.files) : undefined;
  const helmetCandidates = name === 'semgrep' ? parsed.indicators.filter(hit => isHelmetCspCandidateRule(hit.rule)) : [];
  const helmetCandidateCounts = new Map<string, number>();
  for (const hit of helmetCandidates) {
    if (hit.offset === undefined) continue;
    const key = `${hit.path.replace(/^\/?source\//,'')}\0${hit.offset}`;
    helmetCandidateCounts.set(key, (helmetCandidateCounts.get(key) ?? 0) + 1);
  }
  let helmetGateIncomplete = false;
  let missingKubernetes = 0;
  let malformedKubernetes = 0;
  let missingTerraform = 0;
  let missingDockerfiles = 0;
  if (name === 'trivy') {
    const scanned = new Set((parsed.scannedPaths??[]).map(path=>path.replace(/^\/?source\//,'')));
    if ([...scanned].some(path=>!source.files.some(file=>file.path===path))) throw new Error('scanner_unknown_path');
    const candidates = source.files.map(file => ({file,state:classifyKubernetesCandidate(file.path,file.content)})).filter(item=>item.state.candidate || item.state.unrecognized);
    // Only Kubernetes-shaped documents are coverage candidates. Malformed candidates
    // remain unknown even if Trivy emitted a result entry for the file.
    malformedKubernetes=candidates.filter(item=>item.state.unrecognized).length;
    missingKubernetes=candidates.filter(item=>item.state.unrecognized || !scanned.has(item.file.path)).length;
    const terraform = source.files.filter(file=>/\.(?:tf|tfvars|hcl)$/i.test(file.path));
    const dockerfiles = source.files.filter(file=>/(?:^|\/)(?:dockerfile|containerfile)(?:\.[a-z0-9_-]+)?$/i.test(file.path));
    missingTerraform=terraform.filter(file=>!scanned.has(file.path)).length;
    missingDockerfiles=dockerfiles.filter(file=>!scanned.has(file.path)).length;
    if (missingKubernetes || missingTerraform || missingDockerfiles) parsed.incomplete=true;
  }
  const provenance = {image:result.image,profileChecksum:result.profileChecksum,sourceDigest:source.digest,redacted:true,matched:parsed.indicators.length,scanned:parsed.scanned,...(name === 'semgrep' ? {helmetCspGateVersion:HELMET_CSP_GATE_VERSION,typescriptVersion:HELMET_CSP_TYPESCRIPT_VERSION} : {})};
  const tool = {name,version:result.version};
  evidence(a,'configuration',`scanner-profile:${name}`,provenance,tool);
  let truncated = false;
  const correctionLocations = new Map<string,number|undefined>();
  for (const hit of parsed.indicators) {
    if (a.findings.length >= 75 || a.evidence.length >= 150) {truncated=true;break;}
    const path = hit.path.replace(/^\/?source\//,'');
    const file = source.files.find(f=>f.path === path);
    if (!file) throw new Error('scanner_unknown_path');
    const helmetCspCandidate = name === 'semgrep' && isHelmetCspCandidateRule(hit.rule);
    if (helmetCspCandidate) {
      const coordinateKey = hit.offset === undefined ? undefined : `${path}\0${hit.offset}`;
      const coordinateIsUnique = coordinateKey !== undefined && helmetCandidateCounts.get(coordinateKey) === 1;
      if (!coordinateIsUnique || !helmetCspGate?.(path,hit.offset,hit.line,hit.col)) {
        helmetGateIncomplete=true;
        continue;
      }
    }
    let correctionLocationLine: number | undefined;
    if (name === 'trivy' && hit.checkId && hit.causeStartLine !== undefined && hit.causeEndLine !== undefined) {
      const key = `${path}\0${hit.checkId}\0${hit.causeStartLine}\0${hit.causeEndLine}`;
      if (!correctionLocations.has(key)) correctionLocations.set(key,findKubernetesCorrectionLocation(file.content,hit.checkId,hit.causeStartLine,hit.causeEndLine));
      correctionLocationLine = correctionLocations.get(key);
    }
    const location = `${path}:${correctionLocationLine ?? hit.line}`;
    const id = evidence(a,name === 'gitleaks' ? 'source' : name === 'trivy' ? 'configuration':'source',location,{rule:hit.rule,path,line:hit.line,...(hit.checkId === undefined ? {} : {checkId:hit.checkId}),...(hit.causeStartLine === undefined ? {} : {causeStartLine:hit.causeStartLine}),...(hit.causeEndLine === undefined ? {} : {causeEndLine:hit.causeEndLine}),...(correctionLocationLine === undefined ? {} : {correctionLocationLine}),...(hit.offset === undefined ? {} : {offset:hit.offset}),...(hit.col === undefined ? {} : {col:hit.col}),...(hit.cwe === undefined ? {} : {cwe:hit.cwe}),...(hit.owasp === undefined ? {} : {owasp:hit.owasp}),...(hit.precisionNote === undefined ? {} : {precisionNote:hit.precisionNote}),content:'[REDACTED]',sourceDigest:source.digest},tool);
    const cspDescription = 'A Semgrep candidate and bounded TypeScript AST gate found a top-level Helmet configuration that sets contentSecurityPolicy to false. Registration, execution, other CSP mechanisms, deployment, route association, causality, and exploitability remain unknown.';
    const ruleContext = [hit.cwe,hit.owasp,hit.precisionNote ? `Precision: ${hit.precisionNote}` : undefined].filter(Boolean).join(' · ');
    finding(a,{ruleId:hit.rule,correlationKey:helmetCspCandidate ? 'http:content-security-policy' : `${name}:${hit.rule}:${path}`.slice(0,512),title:helmetCspCandidate ? 'Helmet CSP disabling configuration indication' : hit.title ?? `${name} static indicator: ${hit.rule}`.slice(0,256),location,description:helmetCspCandidate ? cspDescription : [hit.description ?? `The controlled ${name} profile matched a static indicator in the uploaded bytes. The source excerpt and any secret value are redacted.`,ruleContext].filter(Boolean).join(' '),severity:hit.severity,confidence:'inferred',impact:helmetCspCandidate ? 'The source configuration may disable Helmet-managed CSP if the call is registered and executed; effective policy and deployment are unknown.' : name === 'gitleaks' ? 'Potential credential material may be exposed; validity and use are unknown.':'The matched source or configuration may weaken a security boundary; runtime reachability is unknown.',recommendation:helmetCspCandidate ? 'Review the intended CSP policy and the independently observed deployed responses.' : hit.recommendation ?? (name === 'gitleaks' ? 'Review privately; revoke and rotate if this is a real credential.':'Review the indicated location and trust boundary, then rescan the updated snapshot.'),limitations:[helmetCspCandidate ? 'Static configuration indication only; registration, execution, other CSP mechanisms, deployment, route association, causality, and exploitability remain unknown.' : 'Static rule match only; no customer code or exploit was executed.'],evidenceIds:[id]});
  }
  if(name === 'trivy') {
    const kubernetesCount = source.files.filter(file => { const state = classifyKubernetesCandidate(file.path,file.content); return state.candidate || state.unrecognized; }).length;
    const terraformCount = source.files.filter(file=>/\.(?:tf|tfvars|hcl)$/i.test(file.path)).length;
    const dockerfileCount = source.files.filter(file=>/(?:^|\/)(?:dockerfile|containerfile)(?:\.[a-z0-9_-]+)?$/i.test(file.path)).length;
    for (const [capability,count,missing] of [['trivy_kubernetes',kubernetesCount,missingKubernetes],['trivy_terraform',terraformCount,missingTerraform],['trivy_dockerfile',dockerfileCount,missingDockerfiles]] as const) {
      a.coverage.push({capability,state:count===0?'unsupported':missing?'unavailable':'inspected',detail:count===0?'No se encontraron candidatos para este perfil.':missing?`${missing} candidato(s) no aparecen en los resultados Trivy; su cobertura es desconocida.`:`Trivy inspeccionó ${count} candidato(s); no encontrar una regla no prueba seguridad.`});
    }
    const totalCandidates = kubernetesCount + terraformCount + dockerfileCount;
    const missingCandidates = missingKubernetes + missingTerraform + missingDockerfiles;
    a.coverage.push({capability:name,state:totalCandidates===0?'unsupported':missingCandidates?'unavailable':'inspected',detail:totalCandidates===0?'No se encontraron candidatos Kubernetes, Terraform ni Dockerfile.':`${totalCandidates} candidatos de configuración considerados; los documentos Kubernetes se clasifican por apiVersion y kind.${missingCandidates ? ` ${missingCandidates} candidato(s) malformado(s), no reconocido(s) o ausente(s) en resultados; su cobertura es desconocida.` : ''}`});
    const kubernetesCoverage = a.coverage.find(item=>item.capability==='trivy_kubernetes');
    if (kubernetesCoverage && missingKubernetes > 0) {
      const omittedKubernetes = missingKubernetes - malformedKubernetes;
      kubernetesCoverage.detail = `${malformedKubernetes} documento(s) Kubernetes malformado(s) o no reconocido(s); ${omittedKubernetes} candidato(s) no aparecen en resultados Trivy. La cobertura restante es desconocida.`;
    }
    return;
  }
  const completedDetail = name === 'semgrep'
    ? 'Semgrep ejecutó el rule pack propio 1.0.0 para JavaScript/TypeScript, Python, Go y Java. Sólo se evalúan los patrones incluidos y no encontrar coincidencias no demuestra seguridad.'
    : name === 'gitleaks'
      ? 'Gitleaks ejecutó la configuración predeterminada completa de la versión 8.28.0 fijada; los valores detectados permanecen redactados y su validez no se comprueba.'
      : 'Trivy ejecutó los comprobadores integrados de Kubernetes, Terraform y Dockerfile sobre los archivos subidos; no encontrar una regla no demuestra seguridad.';
  a.coverage.push({capability:name,state:parsed.incomplete || helmetGateIncomplete || truncated ? 'unavailable':'inspected',detail:helmetGateIncomplete ? 'A Helmet CSP Semgrep candidate lacked a unique call offset or fell outside the bounded parser gate; no correlated finding was emitted for that candidate.' : parsed.incomplete ? 'Scanner reported parsing or analysis errors; findings retain only available evidence.' : truncated ? 'Finding cap reached; additional matches were omitted.' : completedDetail});
}
export async function assessInternal(input: CustomerRunInput, signal: AbortSignal, scanners: ScannerAdapter, advisory?: AdvisoryAdapter) {
  const source = input.source; if (!source) throw new Error('missing_source');
  const a = analysis('internal',`source:${source.id}:sha256:${source.digest}`);
  a.limitations.push('Static analysis only. Customer code, imports, build tools, package scripts and tests never execute.', 'The vendored Semgrep rule pack covers selected JavaScript/TypeScript, Python, Go and Java patterns. Gitleaks uses its pinned default rules. Trivy checks Kubernetes, Terraform and Dockerfile configuration. Rule matches are indications, not proof of exploitability.', 'Package-lock metadata is not proof of installed/deployed packages, reachability, exploitation or compromise. No provider changes or remediation occur.');
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
          const advisory = match.advisories?.find(item => item.id === id);
          const affected = advisory?.affected.filter(item => item.package.ecosystem === 'npm' && item.package.name === pkg.name) ?? [];
          const metadata = advisory ? { id, withdrawn: advisory.withdrawn ?? null, affected } : null;
          if (!metadata || JSON.stringify(metadata).length > 3_500) incomplete = true;
          const evidenceId = evidence(a,'advisory',`osv:${id}`,{schemaVersion:1,id,package:pkg,sourceDigest:source.digest,advisory:metadata && JSON.stringify(metadata).length <= 3_500 ? metadata : null,queriedAt:new Date().toISOString()},{name:'OSV-querybatch',version:'v1'});
          finding(a,{ruleId:`osv.${id}`.slice(0,128),correlationKey:`npm:${pkg.name}:${id}`,title:`Advisory match: ${pkg.name}@${pkg.version}`.slice(0,256),location:pkg.location,description:`The exact ${pkg.relationship} lockfile version matched ${id} in the configured OSV-compatible adapter. Advisory severity was not fetched.`,severity:'unknown',confidence:'observed',impact:'An advisory applies to the recorded version; installed state, reachability and exploitability remain unknown.',recommendation:'Review the advisory and dependency path, choose a supported fix and validate the application.',limitations:['Severity is unassessed; do not interpret this as a low-risk determination.', 'No package installation, package source upload or exploit attempt.'],evidenceIds:[evidenceId]});
        }
      }
      a.coverage.push({capability:'npm_advisories',state:incomplete?'unavailable':'inspected',detail:incomplete?'Advisory results were paginated or capped; remaining matches are unknown.':'Bounded exact-version advisory queries completed at the evidence collection time.'});
    } catch {a.coverage.push({capability:'npm_advisories',state:'unavailable',detail:'Optional advisory adapter missing, failed or exceeded the deadline. No clean dependency claim.'});}
  }
  return finish(a);
}
