import { z } from 'zod';
import { posix } from 'node:path';
import type { CustomerSourceSnapshot } from '@gotchu/contracts';

const packageSchema = z.object({}).passthrough();
const setupPathPattern = /(?:(['"])(?:setupFilesAfterEnv|setupFiles|setup)\1|\b(?:setupFilesAfterEnv|setupFiles|setup)\b)\s*[:=]\s*(?:\[([^\]]{0,4096})\]|(['"])([^'"]{1,512})\3)/g;
const quotedPathPattern = /(['"])([^'"]{1,512})\1/g;
const testConfig = /^(?:vitest\.config\..+|jest\.config\..+|\.mocharc(?:\..+)?|\.avarc(?:\..+)?|ava\.config\..+|playwright\.config\..+|vite\.config\..+|tsconfig[^/]*\.json)$/;
type DependencyChange = { name: string; section: 'dependencies' | 'devDependencies' | 'optionalDependencies'; version: string };
type SuiteIntegrityOptions = {
  scriptName: string;
  regressionTestPath: string | null;
  actionKind?: 'correction' | 'dependency_pull_request';
  dependencyAllowlist?: readonly DependencyChange[];
};

export function validationAdmissionReason(input: { suiteConfigured: boolean; baseDigestMatches: boolean; candidateDigestMatches: boolean; scriptName: string | null; gateOpen: boolean }): string | null {
  if (!input.suiteConfigured) return 'suite_not_configured';
  if (!input.baseDigestMatches) return 'approved_base_digest_mismatch';
  if (!input.candidateDigestMatches) return 'candidate_digest_mismatch';
  if (input.scriptName !== 'test') return 'runner_profile_script_mismatch';
  if (!input.gateOpen) return 'runner_gate_closed';
  return null;
}

export function rescanCoverage(coverage: readonly { capability: string; state: 'inspected' | 'not_requested' | 'unsupported' | 'unavailable' }[]): 'complete' | 'partial' {
  const resolved = coverage.every(item => item.state === 'inspected' || item.state === 'not_requested'
    || item.state === 'unsupported' && (item.capability === 'trivy' || item.capability.startsWith('trivy_')));
  return coverage.length > 0 && resolved ? 'complete' : 'partial';
}

function suiteFile(path: string): boolean {
  return path.startsWith('test/') || path.startsWith('tests/') || path.includes('/__tests__/') || path.startsWith('__tests__/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function parsePackage(files: ReadonlyMap<string, string>): Record<string, unknown> | null {
  const raw = files.get('package.json');
  if (!raw) return null;
  try {
    const parsed = packageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}

function packageChanged(baseFiles: ReadonlyMap<string, string>, candidateFiles: ReadonlyMap<string, string>, options: SuiteIntegrityOptions): boolean {
  const base = parsePackage(baseFiles); const candidate = parsePackage(candidateFiles);
  if (!base || !candidate) return true;
  const allowlist = options.actionKind === 'dependency_pull_request' ? options.dependencyAllowlist ?? [] : [];
  for (const change of allowlist) {
    const baseDependencies = base[change.section]; const candidateDependencies = candidate[change.section];
    if (typeof baseDependencies !== 'object' || baseDependencies === null || typeof candidateDependencies !== 'object' || candidateDependencies === null) return true;
    const before = (baseDependencies as Record<string, unknown>)[change.name];
    const after = (candidateDependencies as Record<string, unknown>)[change.name];
    if (typeof before !== 'string' || after !== change.version) return true;
  }
  const normalized = (source: Record<string, unknown>) => {
    const result = structuredClone(source);
    for (const change of allowlist) {
      const dependencies = result[change.section];
      if (typeof dependencies === 'object' && dependencies !== null) (dependencies as Record<string, unknown>)[change.name] = (base[change.section] as Record<string, unknown>)[change.name];
    }
    return result;
  };
  return stable(normalized(base)) !== stable(normalized(candidate));
}

function setupFiles(files: ReadonlyMap<string, string>): Set<string> {
  const paths = new Set<string>();
  for (const [configPath, content] of files) {
    const configName = configPath.split('/').at(-1);
    if (!configName || !testConfig.test(configName)) continue;
    for (const match of content.matchAll(setupPathPattern)) {
      const references = match[2] === undefined
        ? [match[4] ?? '']
        : [...match[2].matchAll(quotedPathPattern)].map(reference => reference[2]!);
      for (const reference of references) {
        if (reference.includes('\\') || reference.startsWith('/') || /^[A-Za-z]:/.test(reference)) continue;
        const path = posix.normalize(posix.join(posix.dirname(configPath), reference));
        if (path !== '..' && !path.startsWith('../')) paths.add(path);
      }
    }
  }
  return paths;
}

export function suiteModifiedByCandidate(base: CustomerSourceSnapshot, candidate: CustomerSourceSnapshot, options: SuiteIntegrityOptions): boolean {
  const baseFiles = new Map(base.files.map(file => [file.path, file.content]));
  const candidateFiles = new Map(candidate.files.map(file => [file.path, file.content]));
  if (packageChanged(baseFiles, candidateFiles, options)) return true;
  if (options.regressionTestPath && baseFiles.get(options.regressionTestPath) !== candidateFiles.get(options.regressionTestPath)) return true;
  const referencedSetup = new Set([...setupFiles(baseFiles), ...setupFiles(candidateFiles)]);
  return [...new Set([...baseFiles.keys(), ...candidateFiles.keys()])].some(path => {
    const name = path.split('/').at(-1)!;
    const protectedPath = suiteFile(path) || testConfig.test(name) || name === '.npmrc' || ['package-lock.json', 'npm-shrinkwrap.json'].includes(path) || referencedSetup.has(path) || path.split('/').some(part => part === 'node_modules');
    if (!protectedPath) return false;
    if (options.actionKind === 'dependency_pull_request' && ['package-lock.json', 'npm-shrinkwrap.json'].includes(path)) return false;
    return baseFiles.get(path) !== candidateFiles.get(path);
  });
}
