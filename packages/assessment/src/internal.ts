import ts from 'typescript';
import { z } from 'zod';
import type { AssessmentAnalysis, DemoRevision } from '@gotchu/contracts';
import { addEvidence, addFinding, createAnalysis, finishAnalysis } from './evidence.js';
import { loadAdvisory, matchesCapturedLodashRange } from './advisory.js';
import { controlledSourceFileSchema, FILE_TIMEOUT_MS, internalTool, MAX_FILE_BYTES, withDeadline, type ControlledSourceFile } from './profile.js';
import type { ControlledRepositoryPort } from './repository.js';

const settingsSchema = z.object({ responseHeaders: z.record(z.string().min(1), z.string()) }).strict();
const manifestSchema = z.object({ dependencies: z.record(z.string().min(1), z.string().max(200)) });
const fileCapabilities = {
  'store.ts': 'source.audit-email-literal',
  'settings.json': 'configuration.csp',
  'package.json': 'dependencies.captured-advisory',
} satisfies Record<ControlledSourceFile, string>;

function inspectAuditLiteral(text: string) {
  const checked = ts.transpileModule(text, { fileName: 'store.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  if (checked.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return undefined;
  const file = ts.createSourceFile('store.ts', text, ts.ScriptTarget.ES2022, true);
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
      || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'includeCustomerEmailInAudit') declarations.push(declaration);
    }
  }
  const declaration = declarations[0];
  if (declarations.length !== 1 || !declaration?.initializer) return undefined;
  if (declaration.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (declaration.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

async function inspectFile(analysis: AssessmentAnalysis, revision: DemoRevision, path: ControlledSourceFile, bytes: Uint8Array) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const locator = `controlled-demo-store/${revision}/${path}`;
  const evidence = addEvidence(analysis, path === 'store.ts' ? 'source' : path === 'settings.json' ? 'configuration' : 'dependency', locator, bytes);
  if (path === 'store.ts') {
    const enabled = inspectAuditLiteral(text);
    if (enabled === undefined) return 'The exported boolean audit setting is missing, dynamic, duplicated or syntactically invalid; no source conclusion is supported.';
    if (enabled) addFinding(analysis, {
      ruleId: 'controlled.audit-email-literal', correlationKey: 'source:audit-email', title: 'Audit source enables customer email inclusion',
      location: locator, description: 'The TypeScript AST contains an exported includeCustomerEmailInAudit constant set to true. This rule observes the setting; it does not trace its callers or establish runtime logging.',
      severity: 'low', confidence: 'observed', impact: 'Using this formatter with customer data could retain personal information in audit text.',
      recommendation: 'Disable email inclusion and retain only the event fields needed by operators.',
      limitations: ['This literal check is not data-flow analysis. The public catalog route does not invoke the audit formatter.', 'No real customer data, log sink, exfiltration, or externally reachable disclosure was observed.'], evidenceIds: [evidence.id],
    });
    return null;
  }
  if (path === 'settings.json') {
    const result = settingsSchema.safeParse(JSON.parse(text));
    if (!result.success) return 'The configuration does not match the supported responseHeaders object.';
    const headers = new Map<string, string>();
    for (const [name, value] of Object.entries(result.data.responseHeaders)) {
      const normalized = name.toLowerCase();
      if (headers.has(normalized)) return 'Duplicate case-insensitive header configuration is ambiguous.';
      headers.set(normalized, value);
    }
    if (!headers.get('content-security-policy')?.trim()) addFinding(analysis, {
      ruleId: 'controlled.csp-configuration', correlationKey: 'http:content-security-policy', title: 'Response configuration omits Content-Security-Policy',
      location: locator, description: 'The checked responseHeaders configuration has no nonempty Content-Security-Policy value.',
      severity: 'low', confidence: 'observed', impact: 'A browser defense layer is not configured here. This alone does not establish an injection vulnerability or compromise.',
      recommendation: 'Provide a policy appropriate to the catalog and verify the actual HTTP response.',
      limitations: ['This configuration read cannot establish deployed response behavior or effective policy enforcement.'], evidenceIds: [evidence.id],
    });
    return null;
  }
  const result = manifestSchema.safeParse(JSON.parse(text));
  if (!result.success) return 'The dependency manifest does not match the supported dependencies object.';
  const version = result.data.dependencies.lodash;
  if (version !== undefined && matchesCapturedLodashRange(version) === undefined) return 'The lodash declaration is not an exact stable version; range resolution, tags, aliases and prereleases are unsupported.';
  // Keep database provenance even when no match is found; absence of a hit is scoped to this snapshot.
  let captured: Awaited<ReturnType<typeof loadAdvisory>>;
  try { captured = await loadAdvisory(); } catch { return 'The pinned offline advisory snapshot could not be read or validated; dependency coverage is unavailable.'; }
  const advisoryEvidence = addEvidence(analysis, 'advisory', captured.provenance.source, captured.bytes);
  const provenanceEvidence = addEvidence(analysis, 'advisory', 'assessment/advisories/provenance.json', captured.provenanceBytes);
  if (version !== undefined && matchesCapturedLodashRange(version)) addFinding(analysis, {
    ruleId: 'controlled.dependency.GHSA-35jh-r3h4-6jhm', correlationKey: 'dependency:lodash:GHSA-35jh-r3h4-6jhm',
    title: 'Declared lodash version matches a captured advisory range', location: `${locator}#dependencies.lodash`,
    description: `The manifest declares lodash ${version}, inside the captured npm range <4.17.21 for GHSA-35jh-r3h4-6jhm / CVE-2021-23337. Source: ${captured.provenance.source}. Retrieved ${captured.provenance.retrievedAt}; source modified ${captured.provenance.sourceModifiedAt}.`,
    severity: 'high', confidence: 'observed', impact: 'The advisory describes code injection in lodash template options. High is the advisory severity, not a demonstrated impact for this fixture.',
    recommendation: 'Remove the unused declaration, as the corrected fixture does, or verify a supported replacement against current advisories and actual usage.',
    limitations: ['Offline captured advisory only; there is no freshness check at run time and no complete advisory database.', 'Manifest declaration only: no lockfile, installed-package, transitive-dependency or call-reachability verification. The target does not install or use lodash.', 'The captured record identifies 4.17.21 as the fix for this advisory only, not a currently safe version. No exploit was attempted.'],
    evidenceIds: [evidence.id, advisoryEvidence.id, provenanceEvidence.id],
  });
  return null;
}

export async function assessInternal(revision: DemoRevision, repository: ControlledRepositoryPort) {
  const analysis = createAnalysis('internal', internalTool, `controlled-demo-store/${revision}`);
  analysis.limitations.push(
    `Only three fixed files of at most ${MAX_FILE_BYTES} bytes each are read; each read has a ${FILE_TIMEOUT_MS} ms deadline. No directory crawl, repository fetch, import, installation, customer test or dependency script runs.`,
    `Source checking uses TypeScript ${ts.version} AST/literal inspection, not whole-program/data-flow analysis.`,
    'Dependency coverage is one pinned offline advisory and the direct lodash declaration only. Other packages, advisories, installed versions and lockfiles are outside coverage.',
    'Checksums cover exact read bytes. Source/advisory excerpts are UTF-8 prefixes of at most 4096 characters and may omit the tail; originals remain in the controlled fixture or pinned advisory file.',
  );
  let inspected = 0;
  for (const path of controlledSourceFileSchema.options) {
    let bytes: Uint8Array;
    try {
      const received: unknown = await withDeadline(() => repository.readFile(revision, path), FILE_TIMEOUT_MS);
      if (!(received instanceof Uint8Array) || received.byteLength > MAX_FILE_BYTES) throw new Error('Invalid or oversized source bytes');
      bytes = Uint8Array.from(received);
    } catch {
      analysis.coverage.push({ capability: fileCapabilities[path], state: 'unavailable', detail: `${path}: repository read failed, exceeded the deadline, or returned oversized/invalid bytes.` });
      continue;
    }
    let unsupported: string | null;
    try { unsupported = await inspectFile(analysis, revision, path, bytes); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
        unsupported = `${path}: invalid JSON or UTF-8; no conclusion is supported.`;
      } else throw error;
    }
    if (unsupported === null) {
      inspected += 1;
      analysis.coverage.push({ capability: fileCapabilities[path], state: 'inspected', detail: `${path}: bounded deterministic profile completed; a non-match is limited to this rule.` });
    } else {
      analysis.coverage.push({ capability: fileCapabilities[path], state: 'unavailable', detail: unsupported });
    }
  }
  analysis.coverage.push(
    { capability: 'general-static-scanners', state: 'unsupported', detail: 'Semgrep, OSV-Scanner, Gitleaks and Trivy are not integrated. No general vulnerability, secret or container scan is claimed.' },
    { capability: 'customer-code-execution', state: 'unsupported', detail: 'No customer code, scripts, tests or dependency installations run; VM-class isolation is not demonstrated.' },
  );
  return finishAnalysis(analysis, inspected, 3);
}
