import { z } from 'zod';
import type { CustomerSourceSnapshot } from '@gotchu/contracts';

const scriptsSchema = z.record(z.string(), z.string());

function packageScripts(files: ReadonlyMap<string, string>, scriptName: string): string | null {
  const raw = files.get('package.json');
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('scripts' in value)) return null;
    const scripts = scriptsSchema.safeParse(value.scripts);
    if (!scripts.success || !(scriptName in scripts.data)) return null;
    return JSON.stringify(scripts.data);
  } catch { return null; }
}

function suiteFile(path: string): boolean {
  return path.startsWith('test/') || path.startsWith('tests/') || path.includes('/__tests__/') || path.startsWith('__tests__/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function suiteModifiedByCandidate(base: CustomerSourceSnapshot, candidate: CustomerSourceSnapshot, options: { scriptName: string; regressionTestPath: string | null }): boolean {
  const baseFiles = new Map(base.files.map(file => [file.path, file.content]));
  const candidateFiles = new Map(candidate.files.map(file => [file.path, file.content]));
  const scripts = packageScripts(baseFiles, options.scriptName);
  if (!scripts || scripts !== packageScripts(candidateFiles, options.scriptName)) return true;
  if (options.regressionTestPath && baseFiles.get(options.regressionTestPath) !== candidateFiles.get(options.regressionTestPath)) return true;
  return [...new Set([...baseFiles.keys(), ...candidateFiles.keys()].filter(suiteFile))].some(path => baseFiles.get(path) !== candidateFiles.get(path));
}
