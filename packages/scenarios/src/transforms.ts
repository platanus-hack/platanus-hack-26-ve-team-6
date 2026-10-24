import ts from 'typescript';
import type { CustomerSourceSnapshot } from '@gotchu/contracts';

export type TransformBlockReason = 'source_file_not_found' | 'location_unbound' | 'syntax_invalid' | 'ambiguous_transform' | 'unsupported_transform';
export type ExactTransform =
  | { status: 'ready'; path: string; beforeBytes: string; afterBytes: string }
  | { status: 'blocked'; reason: TransformBlockReason };

interface FindingLocation { path: string; line: number }
export interface KubernetesCorrectionBinding { checkId: string; startLine: number; endLine: number; propertyLine: number }

interface KubernetesPropertyCorrection {
  ruleId: string;
  key: 'privileged' | 'allowPrivilegeEscalation' | 'runAsNonRoot' | 'readOnlyRootFilesystem';
  before: boolean;
  after: boolean;
}

const kubernetesCorrections: Readonly<Record<string, KubernetesPropertyCorrection>> = {
  KSV001: { ruleId: 'AVD-KSV-0001', key: 'allowPrivilegeEscalation', before: true, after: false },
  KSV012: { ruleId: 'AVD-KSV-0012', key: 'runAsNonRoot', before: false, after: true },
  KSV014: { ruleId: 'AVD-KSV-0014', key: 'readOnlyRootFilesystem', before: false, after: true },
  KSV017: { ruleId: 'AVD-KSV-0017', key: 'privileged', before: true, after: false },
};

function parseSourceLocation(location: string): FindingLocation | undefined {
  const match = /^(.+):(\d+)$/.exec(location);
  const path = match?.[1];
  const line = Number(match?.[2]);
  if (!path || !Number.isSafeInteger(line) || line < 1) return undefined;
  return { path, line };
}

function parseTsScriptKind(path: string): ts.ScriptKind {
  return /\.tsx$/i.test(path) ? ts.ScriptKind.TSX
    : /\.[cm]?tsx?$/i.test(path) ? ts.ScriptKind.TS
      : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
}

function exactTlsTransform(source: CustomerSourceSnapshot, location: FindingLocation | undefined): ExactTransform {
  if (!location) return { status: 'blocked', reason: 'location_unbound' };
  const sourceFile = source.files.find((file) => file.path === location.path);
  if (!sourceFile) return { status: 'blocked', reason: 'source_file_not_found' };

  const parsed = ts.createSourceFile(sourceFile.path, sourceFile.content, ts.ScriptTarget.Latest, true, parseTsScriptKind(sourceFile.path));
  const diagnostics = ts.transpileModule(sourceFile.content, {
    fileName: sourceFile.path,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.Latest },
  }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return { status: 'blocked', reason: 'syntax_invalid' };

  const candidates: Array<{ start: number; end: number; propertyLine: number; valueLine: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && node.name.text === 'rejectUnauthorized'
      && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      const propertyLine = parsed.getLineAndCharacterOfPosition(node.name.getStart(parsed)).line + 1;
      const valueLine = parsed.getLineAndCharacterOfPosition(node.initializer.getStart(parsed)).line + 1;
      candidates.push({ start: node.initializer.getStart(parsed), end: node.initializer.getEnd(), propertyLine, valueLine });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const matched = candidates.filter((candidate) => candidate.propertyLine === location.line || candidate.valueLine === location.line);
  const candidate = matched.length === 1 ? matched[0] : matched.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
  if (!candidate) return { status: 'blocked', reason: matched.length > 1 || candidates.length > 1 ? 'ambiguous_transform' : 'unsupported_transform' };
  const afterBytes = `${sourceFile.content.slice(0, candidate.start)}true${sourceFile.content.slice(candidate.end)}`;
  return { status: 'ready', path: sourceFile.path, beforeBytes: sourceFile.content, afterBytes };
}

type YamlLine = { text: string; start: number; indent: number; number: number };

function yamlLines(content: string): YamlLine[] {
  const result: YamlLine[] = [];
  let start = 0;
  let number = 1;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const raw = content.slice(start, end);
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const leading = /^[ \t]*/.exec(text)?.[0].length ?? 0;
    result.push({ text, start, indent: leading, number });
    start = newline === -1 ? content.length : newline + 1;
    number += 1;
  }
  return result;
}

function meaningfulYamlLine(line: YamlLine): boolean {
  const trimmed = line.text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

function isInsideAmbiguousScalar(lines: readonly YamlLine[], targetIndex: number): boolean {
  for (let index = 0; index < targetIndex; index += 1) {
    const line = lines[index];
    if (!line || !meaningfulYamlLine(line)) continue;
    const match = /^([ ]*)(?:-[ ]+)?[^:#][^:]*:[ \t]*(\S.*)$/.exec(line.text);
    const value = match?.[2];
    if (value === undefined) continue;
    const keyIndent = (match?.[1]?.length ?? 0) + (line.text.slice(match?.[1]?.length ?? 0).startsWith('- ') ? 2 : 0);
    for (let next = index + 1; next <= targetIndex; next += 1) {
      const following = lines[next];
      if (!following || !meaningfulYamlLine(following)) continue;
      if (following.indent <= keyIndent) break;
      return true;
    }
  }
  return false;
}

function exactKubernetesTransform(
  source: CustomerSourceSnapshot,
  location: FindingLocation | undefined,
  ruleId: string | undefined,
  binding: KubernetesCorrectionBinding | undefined,
): ExactTransform {
  if (!location) return { status: 'blocked', reason: 'location_unbound' };
  if (!/\.ya?ml$/i.test(location.path)) return { status: 'blocked', reason: 'unsupported_transform' };
  const sourceFile = source.files.find((file) => file.path === location.path);
  if (!sourceFile) return { status: 'blocked', reason: 'source_file_not_found' };
  if (!binding) return { status: 'blocked', reason: 'location_unbound' };
  const correction = kubernetesCorrections[binding.checkId];
  if (!correction || correction.ruleId !== ruleId || binding.propertyLine !== location.line
    || binding.startLine < 1 || binding.endLine < binding.startLine
    || binding.propertyLine < binding.startLine || binding.propertyLine > binding.endLine
    || binding.endLine - binding.startLine > 500) return { status: 'blocked', reason: 'location_unbound' };

  // Block scalar bodies are opaque text. This small YAML recognizer never edits inside one.
  if (/^[ \t]*(?:[^#\n]*?:[ \t]*|-[ \t]+[^#\n]*?:[ \t]*)[|>][+-]?[0-9]?[ \t]*(?:#.*)?$/m.test(sourceFile.content)) {
    return { status: 'blocked', reason: 'unsupported_transform' };
  }
  if (/^[ ]*\t/m.test(sourceFile.content)) return { status: 'blocked', reason: 'unsupported_transform' };
  const lines = yamlLines(sourceFile.content);
  const scalarMatches = lines.flatMap((line) => {
    const match = /^([ \t]*)(privileged|allowPrivilegeEscalation|runAsNonRoot|readOnlyRootFilesystem):([ \t]*)(true|false)([ \t]*(?:#.*)?)$/.exec(line.text);
    if (!match) return [];
    const indentation = match[1];
    const key = match[2];
    const spacing = match[3];
    const value = match[4];
    if (indentation === undefined || key === undefined || spacing === undefined || value === undefined) return [];
    const tokenStart = line.start + indentation.length + key.length + 1 + spacing.length;
    return [{ line, key, value: value === 'true', tokenStart, tokenEnd: tokenStart + value.length }];
  });
  const target = scalarMatches.find((candidate) => candidate.line.number === binding.propertyLine
    && candidate.key === correction.key && candidate.value === correction.before);
  if (!target) return { status: 'blocked', reason: 'unsupported_transform' };
  if (isInsideAmbiguousScalar(lines, target.line.number - 1)) return { status: 'blocked', reason: 'unsupported_transform' };

  const parents = lines.flatMap((line, index) => {
    if (!/^([ \t]*)securityContext:[ \t]*(?:#.*)?$/.test(line.text)) return [];
    const indent = /^([ \t]*)/.exec(line.text)?.[1] ?? '';
    return [{ index, indent: indent.length }];
  });
  const contexts = parents.map((parent) => {
    let end = lines.length;
    for (let index = parent.index + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || !meaningfulYamlLine(line)) continue;
      if (line.indent <= parent.indent) { end = index; break; }
    }
    const children = lines.slice(parent.index + 1, end).filter((line) => meaningfulYamlLine(line) && line.indent > parent.indent);
    const childIndent = children.reduce<number | undefined>((minimum, line) => minimum === undefined || line.indent < minimum ? line.indent : minimum, undefined);
    return { ...parent, end, childIndent };
  });
  const containingContexts = contexts.filter((candidate) => candidate.childIndent !== undefined
    && target.line.number - 1 > candidate.index && target.line.number - 1 < candidate.end
    && target.line.indent === candidate.childIndent);
  const context = containingContexts.length === 1 ? containingContexts[0] : undefined;
  if (!context) return { status: 'blocked', reason: 'unsupported_transform' };

  const sameKeyInContext = scalarMatches.filter((candidate) => candidate.key === target.key
    && candidate.line.number - 1 > context.index && candidate.line.number - 1 < context.end
    && candidate.line.indent === context.childIndent);
  if (sameKeyInContext.length !== 1) return { status: 'blocked', reason: 'ambiguous_transform' };

  const afterBytes = `${sourceFile.content.slice(0, target.tokenStart)}${correction.after}${sourceFile.content.slice(target.tokenEnd)}`;
  return { status: 'ready', path: sourceFile.path, beforeBytes: sourceFile.content, afterBytes };
}

export function inspectExactTransform(
  recipeId: string,
  source: CustomerSourceSnapshot,
  findingLocation: string,
  ruleId?: string,
  kubernetesBinding?: KubernetesCorrectionBinding,
): ExactTransform {
  const location = parseSourceLocation(findingLocation);
  if (recipeId === 'tls-certificate-verification') return exactTlsTransform(source, location);
  if (recipeId === 'kubernetes-config-hardening') return exactKubernetesTransform(source, location, ruleId, kubernetesBinding);
  return { status: 'blocked', reason: 'unsupported_transform' };
}

export function replaceSourceFile(source: CustomerSourceSnapshot, path: string, content: string): CustomerSourceSnapshot {
  return { revision: source.revision, files: source.files.map((file) => file.path === path ? { ...file, content } : file) };
}
