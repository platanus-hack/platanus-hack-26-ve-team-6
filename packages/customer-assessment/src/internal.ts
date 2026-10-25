import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { customerSourceFileSchema, defaultLicensePolicy, type AssessmentAnalysis, type AssessmentFinding, type CustomerRunInput, type DependencyArtifactAnalysis, type DependencyArtifactFinding, type DependencyReachability } from '@gotchu/contracts';
import { analysis, bounded, isScannerCleanupError, evidence, finding, finish } from './common.js';
import type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
import { parseLockfile, type AdvisoryAdapter, type AdvisoryMatch } from './advisory.js';
import type { OsvAdvisoryMetadata } from '@gotchu/contracts';
import type { LockedPackage } from './lockfiles.js';
import type { LicenseAdapter, LicenseLookup } from './licenses.js';
import { evaluateLicensePolicy, normalizeLicenseExpression, normalizeLicensePolicy } from './licenses.js';
import { createHelmetCspGate, HELMET_CSP_GATE_VERSION, isHelmetCspCandidateRule, HELMET_CSP_TYPESCRIPT_VERSION } from './helmet-csp-gate.js';
import { classifyKubernetesCandidate, findKubernetesCorrectionLocation } from './kubernetes.js';
import type { NpmArtifactAdapter, NpmArtifactScanner, NpmArtifactSourceFile } from './npm-artifacts.js';
import { analyzeDependencyReachability } from './reachability.js';

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
export function createNpmArtifactScanner(scanners: ScannerAdapter): NpmArtifactScanner {
  return async ({ package: pkg, artifactSha256 }, rawFiles, signal) => {
    const packageLabel = `${pkg.name}@${pkg.version}`;
    const files: NpmArtifactSourceFile[] = [];
    let totalBytes = 0;
    let complete = rawFiles.length > 0;
    for (const file of rawFiles) {
      const parsed = customerSourceFileSchema.safeParse(file);
      if (!parsed.success || files.length >= 1_000 || totalBytes + Buffer.byteLength(file.content, 'utf8') > 4 * 1_048_576) {
        complete = false;
        continue;
      }
      files.push(file);
      totalBytes += Buffer.byteLength(file.content, 'utf8');
    }
    if (files.length === 0) return { findings: [], tools: [], evidence: [], complete: false };
    const source = { id: randomUUID(), digest: artifactSha256, revision: `npm:${packageLabel}`, files };
    const artifactAnalysis = analysis('internal', `dependency:${packageLabel}:sha256:${artifactSha256}`);
    const tools: { name: 'semgrep' | 'gitleaks'; version: string; image: string; profileChecksum: string }[] = [];
    const findings: DependencyArtifactFinding[] = [];
    for (const name of ['semgrep', 'gitleaks'] as const) {
      signal.throwIfAborted();
      try {
        const result = await scanners.run(name, source, signal);
        const before = artifactAnalysis.findings.length;
        addTool(artifactAnalysis, name, result, source);
        tools.push({ name, version: result.version, image: result.image, profileChecksum: result.profileChecksum });
        for (const finding of artifactAnalysis.findings.slice(before)) {
          findings.push({
            tool: name,
            ruleId: finding.ruleId,
            title: finding.title,
            location: `${packageLabel}:${finding.location}`.slice(0, 1_024),
            severity: finding.severity,
            confidence: finding.confidence,
            exploitability: finding.exploitability,
            description: finding.description.slice(0, 2_000),
            evidenceIds: finding.evidenceIds,
          });
        }
        if (artifactAnalysis.coverage.at(-1)?.state !== 'inspected') complete = false;
      } catch (error) {
        if (isScannerCleanupError(error)) throw error;
        complete = false;
      }
    }
    if (findings.length > 40) complete = false;
    const retained = findings.slice(0, 40);
    const retainedEvidenceIds = new Set(retained.flatMap(item => item.evidenceIds));
    const evidence = artifactAnalysis.evidence
      .filter(item => item.kind === 'configuration' || retainedEvidenceIds.has(item.id))
      .slice(0, 100)
      .map(item => ({ ...item, locator: `${packageLabel}:${item.locator}`.slice(0, 1_024) }));
    const validEvidenceIds = new Set(evidence.map(item => item.id));
    const retainedFindings = retained.filter(item => item.evidenceIds.every(id => validEvidenceIds.has(id)));
    return { findings: retainedFindings, tools, evidence, complete: complete && retainedFindings.length === findings.length };
  };
}

export async function assessInternal(input: CustomerRunInput, signal: AbortSignal, scanners: ScannerAdapter, advisory?: AdvisoryAdapter, licenses?: LicenseAdapter, artifacts?: NpmArtifactAdapter) {
  const source = input.source; if (!source) throw new Error('missing_source');
  const a = analysis('internal',`source:${source.id}:sha256:${source.digest}`);
  a.limitations.push('Static analysis only. Customer code, imports, build tools, package scripts and tests never execute.', 'The vendored Semgrep rule pack covers selected JavaScript/TypeScript, Python, Go and Java patterns. Gitleaks uses its pinned default rules. Trivy checks Kubernetes, Terraform and Dockerfile configuration. Rule matches are indications, not proof of exploitability.', 'Lockfile metadata is not proof of installed/deployed packages, reachability, exploitation or compromise. License values are declared metadata, not verified license text. No provider changes or remediation occur.');
  const names: ScannerName[] = ['semgrep','gitleaks','trivy'];
  const results = await Promise.allSettled(names.map(name=>bounded(()=>scanners.run(name,source,signal),signal)));
  for (let i=0;i<names.length;i++) {
    const name = names[i]; const result = results[i]; if (!name || !result) continue;
    const beforeEvidence = a.evidence.length; const beforeFindings = a.findings.length;
    try { if(result.status === 'rejected') throw result.reason; addTool(a,name,result.value,source); }
    catch (error) { if (isScannerCleanupError(error)) throw error; a.evidence.length=beforeEvidence; a.findings.length=beforeFindings; a.coverage.push({capability:name,state:'unavailable',detail:'Pinned scanner unavailable, malformed output, resource/deadline exceeded or invalid source mapping. No clean result inferred.'}); }
  }
  const locked = parseLockfile(source);
  const policy = normalizeLicensePolicy(input.licensePolicy ?? defaultLicensePolicy);
  const uniquePackages = [...new Map(locked.inventory.map(pkg => [`${pkg.name}\0${pkg.version}`, pkg])).values()];
  const licenseResults = new Map<string, LicenseLookup>();
  let licenseLookupComplete = true;
  const needingRegistry = uniquePackages.filter(pkg => pkg.declaredLicense === null);
  if (needingRegistry.length > 0) {
    if (!licenses) licenseLookupComplete = false;
    else {
      const lookupBatch = needingRegistry.slice(0, 200);
      try {
        const results = await bounded(() => licenses.lookup(lookupBatch.map(({ name, version }) => ({ name, version })), signal), signal);
        if (results.length !== lookupBatch.length) throw new Error('license_lookup_count');
        for (let index = 0; index < lookupBatch.length; index++) {
          const pkg = lookupBatch[index]; const result = results[index];
          if (pkg && result) licenseResults.set(`${pkg.name}\0${pkg.version}`, result);
        }
        licenseLookupComplete = needingRegistry.length <= 200 && results.every(result => result.complete);
      } catch {
        licenseLookupComplete = false;
      }
    }
  }
  if (needingRegistry.length > 200) licenseLookupComplete = false;

  const inventoryComponents = locked.inventory.map(pkg => {
    const registryResult = licenseResults.get(`${pkg.name}\0${pkg.version}`);
    const registryComplete = registryResult?.complete === true;
    const declaredLicense = pkg.declaredLicense ?? (registryComplete ? registryResult.declaredLicense : null);
    const licenseSource = pkg.declaredLicense !== null ? 'lockfile' as const : registryComplete ? 'registry' as const : 'unknown' as const;
    const licenseExpression = normalizeLicenseExpression(declaredLicense);
    return {
      ...pkg,
      dependencies: pkg.dependencies,
      declaredLicense,
      licenseExpression,
      licenseSource,
      licenseConfidence: declaredLicense === null ? 'unknown' as const : 'declared' as const,
      policyStatus: evaluateLicensePolicy(licenseExpression, policy),
    };
  });
  const dependencyInventory = {
    components: inventoryComponents,
    lockfiles: locked.lockfiles,
    policy,
    complete: locked.complete,
    graphComplete: locked.graphComplete,
    unknownCount: locked.unknownCount,
  };
  a.dependencyInventory = dependencyInventory;
  a.coverage.push({
    capability: 'dependency_inventory',
    state: locked.complete ? 'inspected' : 'unavailable',
    detail: !locked.found
      ? 'No supported JavaScript lockfile was uploaded. Exact dependency inventory is unknown; recognized unsupported lockfiles remain listed in coverage.'
      : locked.complete
        ? `Resolved ${locked.inventory.length} exact package versions from ${locked.lockfiles.map(file => file.format).join(', ')} lockfiles without installing packages or executing customer code.`
        : `Resolved ${locked.inventory.length} exact package versions with ${locked.unknownCount} unsupported, malformed or capped lockfile entries. The remaining inventory coverage is unknown.`,
  });

  const advisoryByPackage = new Map<string, { ids: string[]; symbols: string[]; complete: boolean; metadata: Map<string, OsvAdvisoryMetadata> }>();
  let advisoryIncomplete = false;
  if (!advisory) {
    advisoryIncomplete = true;
    a.coverage.push({ capability: 'dependency_advisories', state: 'unavailable', detail: 'Optional OSV adapter is not configured. No clean dependency claim.' });
  } else try {
    // Keep each adapter request bounded while covering ordinary npm projects
    // that exceed one request. Larger inventories remain explicitly partial.
    const advisoryPackages = uniquePackages.slice(0, 500);
    const matches: AdvisoryMatch[] = [];
    for (let offset = 0; offset < advisoryPackages.length; offset += 200) {
      const batch = advisoryPackages.slice(offset, offset + 200);
      const result = await bounded(() => advisory.query(batch.map(({ name, version }) => ({ name, version })), signal), signal);
      if (result.length !== batch.length) throw new Error('advisory_count');
      matches.push(...result);
    }
    advisoryIncomplete = !locked.complete || uniquePackages.length > advisoryPackages.length || matches.some(match => !match.complete);
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index]; const pkg = advisoryPackages[index]; if (!match || !pkg) continue;
      const records = (match.advisories ?? []).flatMap(item => item.affected.some(affected => affected.package.ecosystem === 'npm' && affected.package.name === pkg.name) ? [item] : []);
      advisoryByPackage.set(`${pkg.name}\0${pkg.version}`, {
        ids: match.ids,
        symbols: [...new Set(records.flatMap(item => item.affected.filter(affected => affected.package.ecosystem === 'npm' && affected.package.name === pkg.name).flatMap(affected => affected.symbols ?? [])))].slice(0, 50),
        complete: match.complete,
        metadata: new Map(records.map(item => [item.id, item])),
      });
    }
    a.coverage.push({ capability: 'dependency_advisories', state: advisoryIncomplete ? 'unavailable' : 'inspected', detail: advisoryIncomplete
      ? `The bounded exact-version OSV query covered at most ${advisoryPackages.length} unique package versions. Remaining results are unknown.${locked.complete ? '' : ' The source dependency inventory is incomplete or unsupported.'}`
      : 'Bounded exact-version advisory queries completed; only package names and exact versions were sent to OSV.' });
  } catch {
    advisoryIncomplete = true;
    a.coverage.push({ capability: 'dependency_advisories', state: 'unavailable', detail: 'Optional OSV adapter failed or exceeded its request cap. No clean dependency claim.' });
  }

  const vulnerablePackages = uniquePackages.filter(pkg => (advisoryByPackage.get(`${pkg.name}\0${pkg.version}`)?.ids.length ?? 0) > 0);
  const symbolsByPackage = new Map(vulnerablePackages.map(pkg => [`${pkg.name}\0${pkg.version}`, advisoryByPackage.get(`${pkg.name}\0${pkg.version}`)?.symbols ?? []]));
  const reachability = analyzeDependencyReachability(source, locked.inventory, vulnerablePackages, symbolsByPackage, locked.graphComplete);
  for (const pkg of vulnerablePackages) {
    const value = reachability.get(pkg.purl);
  }
  a.coverage.push({
    capability: 'dependency_reachability',
    state: vulnerablePackages.length === 0 ? 'not_requested' : [...reachability.values()].some(value => value.state === 'unknown') ? 'unavailable' : 'inspected',
    detail: vulnerablePackages.length === 0
      ? 'Reachability was not requested because no exact-version advisory match was available.'
      : 'A TypeScript compiler AST inspected supported JavaScript/TypeScript import, require, literal dynamic import and re-export syntax. Static non-matches are not proof of unreachability.',
  });

  const artifactByPackage = new Map<string, { analysis: DependencyArtifactAnalysis; evidence: AssessmentAnalysis['evidence'] }>();
  const prioritized = [...vulnerablePackages].sort((left, right) => {
    const rank = (pkg: LockedPackage) => {
      const state = reachability.get(pkg.purl)?.state;
      return (state === 'reachable' ? 0 : state === 'imported' ? 1 : state === 'unknown' ? 2 : 3) * 2 + (pkg.relationship === 'direct' ? 0 : 1);
    };
    return rank(left) - rank(right) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
  });
  const artifactBatch = prioritized.slice(0, 3);
  if (artifacts && artifactBatch.length > 0) {
    try {
      const results = await bounded(() => artifacts.analyze(artifactBatch.map(pkg => ({ name: pkg.name, version: pkg.version, integrity: pkg.integrity })), signal), signal);
      for (const pkg of artifactBatch) {
        const result = results.get(`${pkg.name}\0${pkg.version}`);
        artifactByPackage.set(`${pkg.name}\0${pkg.version}`, result ?? {
          analysis: { status: 'unavailable', integrity: 'missing', artifactSha256: null, extractedFileCount: 0, scannedFileCount: 0, tools: [], findings: [], limitation: ['The npm artifact adapter returned no result for this exact package version.'] }, evidence: [],
        });
      }
    } catch (error) {
      if (signal.aborted || isScannerCleanupError(error)) throw error;
      for (const pkg of artifactBatch) artifactByPackage.set(`${pkg.name}\0${pkg.version}`, {
        analysis: { status: 'unavailable', integrity: 'missing', artifactSha256: null, extractedFileCount: 0, scannedFileCount: 0, tools: [], findings: [], limitation: ['Exact npm artifact analysis failed or exceeded its time bound; no clean package-content result is inferred.'] }, evidence: [],
      });
    }
  }

  const artifactState = (pkg: LockedPackage) => artifactByPackage.get(`${pkg.name}\0${pkg.version}`)?.analysis.status ?? 'not_requested';
  for (const pkg of vulnerablePackages) {
    const key = `${pkg.name}\0${pkg.version}`;
    const result = artifactByPackage.get(key);
    if (!result) continue;
    let remaining = 200 - a.evidence.length;
    const retainedEvidence = result.evidence.slice(0, Math.max(0, remaining));
    const evidenceIds = new Set(retainedEvidence.map(item => item.id));
    const findings = result.analysis.findings.filter(item => item.evidenceIds.every(id => evidenceIds.has(id)));
    remaining -= retainedEvidence.length;
    a.evidence.push(...retainedEvidence.map(item => ({ ...item, snapshotRef: a.snapshotRef })));
    const scanTruncated = findings.length !== result.analysis.findings.length || remaining < 0;
    artifactByPackage.set(key, {
      evidence: retainedEvidence,
      analysis: scanTruncated ? { ...result.analysis, status: result.analysis.status === 'checksum_mismatch' ? 'checksum_mismatch' : 'scan_incomplete', findings, limitation: [...result.analysis.limitation, 'Artifact evidence exceeded the report bound; omitted evidence remains unknown.'].slice(0, 10) } : { ...result.analysis, findings },
    });
  }

  const inventoryWithD12 = inventoryComponents.map(component => {
    const key = `${component.name}\0${component.version}`;
    const reachabilityResult = reachability.get(component.purl);
    const artifact = artifactByPackage.get(key)?.analysis;
    return {
      ...component,
      ...(reachabilityResult ? { reachability: reachabilityResult } : {}),
      ...(vulnerablePackages.some(pkg => pkg.name === component.name && pkg.version === component.version) ? {
        artifactAnalysis: artifact ?? {
          status: 'not_requested' as const,
          integrity: 'missing' as const,
          artifactSha256: null,
          extractedFileCount: 0,
          scannedFileCount: 0,
          tools: [],
          findings: [],
          limitation: [artifacts ? 'This package was outside the per-assessment artifact analysis cap.' : 'Exact npm artifact analysis is not configured.'],
        },
      } : {}),
    };
  });
  a.dependencyInventory = { ...dependencyInventory, components: inventoryWithD12 };

  const anyArtifactIncomplete = vulnerablePackages.some(pkg => artifactState(pkg) !== 'verified');
  a.coverage.push({
    capability: 'dependency_artifact_analysis',
    state: vulnerablePackages.length === 0 ? 'not_requested' : artifacts && artifactBatch.length === vulnerablePackages.length && !anyArtifactIncomplete ? 'inspected' : 'unavailable',
    detail: vulnerablePackages.length === 0
      ? 'Exact package artifact analysis was not requested because OSV returned no advisory match.'
      : artifacts
        ? `At most ${artifactBatch.length} prioritized exact npm artifacts were fetched, SHA-512 checked, safely extracted in memory, and sent to Semgrep/Gitleaks. Other versions and incomplete results remain unknown.`
        : 'Exact npm artifact adapter is not configured. Package contents, registry substitution and source-profile findings remain unknown.',
  });

  let advisoryFindingsIncomplete = false;
  for (const pkg of vulnerablePackages) {
    const key = `${pkg.name}\0${pkg.version}`;
    const packageReachability = reachability.get(pkg.purl) ?? {
      state: 'unknown', symbolCoverage: 'unknown', symbols: [], importEvidence: [], symbolEvidence: [], dependencyPath: null,
      limitation: ['Static reachability analysis did not produce a result.'],
    } satisfies DependencyReachability;
    const packageArtifact = artifactByPackage.get(key)?.analysis;
    const integrityMismatchCount = vulnerablePackages.filter(item => artifactState(item) === 'checksum_mismatch').length;
    for (const id of advisoryByPackage.get(key)?.ids ?? []) {
      if (a.findings.length >= 100 - integrityMismatchCount || a.evidence.length >= 200) { advisoryFindingsIncomplete = true; break; }
      const record = advisoryByPackage.get(key)?.metadata.get(id);
      const metadata = record ? { id, withdrawn: record.withdrawn ?? null, affected: record.affected.filter(item => item.package.ecosystem === 'npm' && item.package.name === pkg.name) } : null;
      const metadataIsBounded = metadata !== null && JSON.stringify(metadata).length <= 3_500;
      const evidenceId = evidence(a, 'advisory', `osv:${id}`, { schemaVersion: 2, id, package: pkg, sourceDigest: source.digest,
        advisory: metadataIsBounded ? metadata : null, queriedAt: new Date().toISOString() }, { name: 'OSV-querybatch', version: 'v1' });
      finding(a, {
        ruleId: `osv.${id}`.slice(0, 128), correlationKey: `npm:${pkg.name}:${id}`, title: `Advisory match: ${pkg.name}@${pkg.version}`.slice(0, 256), location: pkg.location,
        description: `The exact ${pkg.relationship} lockfile version matched ${id}. Severity, package import reachability, symbol use and exploitability are separate assessments.`, severity: 'unknown', confidence: 'observed',
        impact: 'An advisory applies to the recorded version. The static import result and package-content scan do not establish deployment or exploitability.', recommendation: 'Review the advisory, import evidence and package artifact findings; choose a supported fix and validate the application.',
        limitations: ['OSV did not provide a normalized severity value for this result; severity remains unknown.', 'Static import analysis cannot resolve every runtime loader, bundler alias or framework convention.', 'No package installation or exploit attempt.'],
        evidenceIds: [evidenceId], dependencyAssessment: { name: pkg.name, version: pkg.version, purl: pkg.purl, reachability: packageReachability, artifactStatus: packageArtifact?.status ?? 'not_requested' },
      });
    }
  }

  for (const pkg of vulnerablePackages) {
    const artifact = artifactByPackage.get(`${pkg.name}\0${pkg.version}`)?.analysis;
    if (artifact?.status !== 'checksum_mismatch' || a.findings.length >= 100 || a.evidence.length >= 200) continue;
    const evidenceId = evidence(a, 'dependency', `npm-registry:${pkg.name}@${pkg.version}`, {
      name: pkg.name, version: pkg.version, lockfileIntegrity: pkg.integrity, artifactSha256: artifact.artifactSha256, verification: artifact.status,
    }, { name: 'npm-registry-tarball-verifier', version: 'v1' });
    const packageReachability = reachability.get(pkg.purl) ?? {
      state: 'unknown', symbolCoverage: 'unknown', symbols: [], importEvidence: [], symbolEvidence: [], dependencyPath: null,
      limitation: ['Static reachability analysis did not produce a result.'],
    } satisfies DependencyReachability;
    finding(a, {
      ruleId: 'dependency.artifact.integrity_mismatch', correlationKey: `npm:${pkg.name}:${pkg.version}:integrity`, title: `Checksum mismatch: ${pkg.name}@${pkg.version}`.slice(0, 256), location: pkg.location,
      description: `The downloaded npm registry artifact for ${pkg.name}@${pkg.version} did not match the recorded SHA-512 integrity value. The artifact was not extracted or scanned.`, severity: 'high', confidence: 'observed',
      impact: 'The exact package bytes differ from the lockfile expectation. This is a high-signal integrity discrepancy, but it does not alone prove malicious substitution or exploitation.', recommendation: 'Do not consume this artifact until the lockfile and registry provenance are independently reconciled.',
      limitations: ['The mismatch could arise from tampered or stale lockfile data or registry substitution; this check does not attribute a cause.', 'No package code was executed.', 'Maintainer Git main was not compared with the published artifact.'],
      evidenceIds: [evidenceId], dependencyAssessment: { name: pkg.name, version: pkg.version, purl: pkg.purl, reachability: packageReachability, artifactStatus: artifact.status },
    });
  }
  if (advisoryFindingsIncomplete) {
    const coverage = a.coverage.find(item => item.capability === 'dependency_advisories');
    if (coverage) {
      coverage.state = 'unavailable';
      coverage.detail += ' Advisory findings exceeded the report bound; omitted matches remain unknown.';
    }
  }
  // Advisory and integrity observations take precedence over license review notices.
  let licenseFindingsIncomplete = false;
  for (const component of inventoryComponents) {
    if (component.policyStatus === 'allowed') continue;
    if (a.findings.length >= 100 || a.evidence.length >= 200) { licenseFindingsIncomplete = true; break; }
    const evidenceId = evidence(a, 'dependency', component.location.slice(0, 1_024), {
      package: { name: component.name, version: component.version, purl: component.purl },
      declaredLicense: component.declaredLicense,
      normalizedLicense: component.licenseExpression,
      licenseSource: component.licenseSource,
      sourceFile: component.sourceFile,
      sourceDigest: source.digest,
      policyStatus: component.policyStatus,
    }, { name: component.licenseSource === 'registry' ? 'npm-registry-version-metadata' : 'lockfile-license-metadata', version: 'v1' });
    const denied = component.policyStatus === 'denied';
    finding(a, {
      ruleId: denied ? 'license.policy.denied' : 'license.policy.review',
      correlationKey: `license:${component.name}:${component.version}`.slice(0, 512),
      title: denied ? `Licencia no permitida: ${component.name}` : `Revisar licencia: ${component.name}`,
      location: component.location,
      description: component.licenseExpression
        ? `La licencia declarada ${component.licenseExpression} para ${component.name}@${component.version} se clasificó como ${denied ? 'denegada' : 'requiere revisión'} según la política del espacio de trabajo.`
        : `No se encontró una expresión SPDX declarada para ${component.name}@${component.version}; la política del espacio de trabajo la mantiene en revisión.`,
      severity: 'unknown',
      confidence: 'observed',
      impact: 'La clasificación describe metadatos de licencia declarados. Gotchu no verificó el texto de licencia incluido en el paquete.',
      recommendation: 'Revisa la licencia y la política del espacio de trabajo antes de aprobar el uso de este paquete.',
      limitations: ['La licencia procede de metadatos declarados y no está verificada contra el contenido del paquete.', 'No se instalaron paquetes ni se ejecutó código del cliente.'],
      evidenceIds: [evidenceId],
    });
  }
  a.coverage.push({
    capability: 'license_metadata',
    state: locked.complete && licenseLookupComplete && !licenseFindingsIncomplete ? 'inspected' : 'unavailable',
    detail: !locked.found
      ? 'No dependency inventory was available for license evaluation.'
      : !locked.complete
        ? 'Dependency inventory is incomplete or unsupported. License metadata for missing packages remains unknown.'
      : licenseLookupComplete && !licenseFindingsIncomplete
        ? `Evaluated declared license metadata for ${inventoryComponents.length} exact package versions. Missing or unrecognized licenses remain in review; declarations are not verified.`
        : `License registry lookups or policy findings were capped or unavailable. ${inventoryComponents.filter(component => component.licenseConfidence === 'unknown').length} packages have unknown declared license metadata.`,
  });

  return finish(a);
}
