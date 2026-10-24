import { loadAll } from 'js-yaml';

const maximumFileCharacters = 1_048_576;
const maximumDocuments = 100;
const maximumCauseLines = 500;
const maximumYamlLines = 50_000;

interface CandidateState {
  candidate: boolean;
  unrecognized: boolean;
}

interface KubernetesLiteral {
  readonly key: string;
  readonly current: boolean;
}

const correctionLiterals: Readonly<Record<string, KubernetesLiteral>> = {
  KSV001: { key: 'allowPrivilegeEscalation', current: true },
  KSV012: { key: 'runAsNonRoot', current: false },
  KSV014: { key: 'readOnlyRootFilesystem', current: false },
  KSV017: { key: 'privileged', current: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKubernetesDocument(value: unknown): boolean {
  return isRecord(value)
    && typeof value.apiVersion === 'string' && value.apiVersion.length > 0
    && typeof value.kind === 'string' && value.kind.length > 0;
}

function countYamlDocuments(content: string): number | undefined {
  const separator = /^---[ \t]*(?:#.*)?$/gm;
  let count = 1;
  while (separator.exec(content)) {
    count += 1;
    if (count > maximumDocuments) return undefined;
  }
  return count;
}

function exceedsYamlLineLimit(content: string): boolean {
  let count = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue;
    count += 1;
    if (count > maximumYamlLines) return true;
  }
  return false;
}

function yamlHeaderCandidate(content: string): boolean {
  let apiVersion = false;
  let kind = false;
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const rawLine = content.slice(start, end);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (/^(?:---|\.\.\.)[ \t]*(?:#.*)?$/.test(line)) {
      if (apiVersion && kind) return true;
      apiVersion = false;
      kind = false;
    } else if (!line.startsWith('#') && !/^[ \t]/.test(line)) {
      const match = /^(?:"(apiVersion|kind)"|'(apiVersion|kind)'|(apiVersion|kind))[ \t]*:[ \t]*(.*?)[ \t]*(?:#.*)?$/.exec(line);
      const key = match?.[1] ?? match?.[2] ?? match?.[3];
      if (key && match?.[4]) {
        if (key === 'apiVersion') apiVersion = true;
        if (key === 'kind') kind = true;
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return apiVersion && kind;
}

function isYamlStringScalar(value: string): boolean {
  const trimmed = value.replace(/[ \t]+#.*$/, '').trim();
  if (!trimmed) return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.length >= 2;
  if (/^[\[\]{},&*!>|`]/.test(trimmed) || /^(?:null|~|true|false)$/i.test(trimmed) || /^[-+]?\d/.test(trimmed)) return false;
  return true;
}

function jsonHeaderCandidate(content: string): boolean {
  let objectDepth = 0;
  let arrayDepth = 0;
  const keys = new Set<string>();
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < content.length; index += 1) {
        const current = content[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') break;
      }
      if (index >= content.length || objectDepth !== 1 || arrayDepth !== 0) continue;
      let after = index + 1;
      while (/\s/.test(content[after] ?? '')) after += 1;
      if (content[after] !== ':') continue;
      try {
        const key: unknown = JSON.parse(content.slice(start, index + 1));
        if (key === 'apiVersion' || key === 'kind') keys.add(key);
      } catch {
        // An invalid key cannot establish a candidate.
      }
    } else if (character === '{') objectDepth += 1;
    else if (character === '}') objectDepth = Math.max(0, objectDepth - 1);
    else if (character === '[') arrayDepth += 1;
    else if (character === ']') arrayDepth = Math.max(0, arrayDepth - 1);
  }
  return keys.has('apiVersion') && keys.has('kind');
}

export function classifyKubernetesCandidate(path: string, content: string): CandidateState {
  if (!/\.(?:ya?ml|json)$/i.test(path)) return { candidate: false, unrecognized: false };
  if (content.length > maximumFileCharacters) return { candidate: true, unrecognized: true };

  if (/\.json$/i.test(path)) {
    try {
      const parsed: unknown = JSON.parse(content);
      return { candidate: isKubernetesDocument(parsed), unrecognized: false };
    } catch {
      const candidate = jsonHeaderCandidate(content);
      return { candidate, unrecognized: candidate };
    }
  }

  if (countYamlDocuments(content) === undefined || exceedsYamlLineLimit(content)) {
    const candidate = yamlHeaderCandidate(content);
    return { candidate, unrecognized: candidate };
  }
  try {
    const documents = loadAll(content, { maxAliasCount: 50 });
    return { candidate: documents.some(isKubernetesDocument), unrecognized: false };
  } catch {
    const candidate = yamlHeaderCandidate(content);
    return { candidate, unrecognized: candidate };
  }
}

interface ParsedYamlLine {
  readonly line: number;
  readonly path: readonly string[];
  readonly key: string;
  readonly value: string;
  readonly document: number;
}

interface PathSegment {
  readonly indent: number;
  readonly value: string;
}

function parseYamlLines(content: string): ParsedYamlLine[] | undefined {
  if (/^[ ]*\t/m.test(content)
    || /^[ \t]*(?:[^#\n]*?:[ \t]*|-[ \t]+[^#\n]*?:[ \t]*)[|>][+-]?[0-9]?[ \t]*(?:#.*)?$/m.test(content)) return undefined;
  const stack: PathSegment[] = [];
  const parsed: ParsedYamlLine[] = [];
  let document = 0;
  let documentHasContent = false;
  const lines = content.split(/\r?\n/);
  if (lines.length > maximumYamlLines) return undefined;

  const addEntry = (line: number, indent: number, text: string, active: PathSegment[]) => {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]*(.*))?$/.exec(text);
    if (!match?.[1]) return;
    const key = match[1];
    const value = match[2]?.trim() ?? '';
    parsed.push({ line, path: [...active.map(segment => segment.value), key], key, value, document });
    active.push({ indent, value: key });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^---[ \t]*(?:#.*)?$/.test(line) || /^\.\.\.[ \t]*(?:#.*)?$/.test(line)) {
      if (documentHasContent) document += 1;
      stack.length = 0;
      documentHasContent = false;
      continue;
    }
    const contentStart = line.search(/\S/);
    if (contentStart < 0 || line.slice(contentStart).startsWith('#')) continue;
    documentHasContent = true;
    const text = line.slice(contentStart);
    const sequence = /^-[ \t]+(.*)$/.exec(text);
    if (sequence) {
      const itemIndent = contentStart;
      while (stack.at(-1)?.indent !== undefined && (stack.at(-1)?.indent ?? -1) >= itemIndent) stack.pop();
      stack.push({ indent: itemIndent, value: '[]' });
      const mappingIndent = itemIndent + 2;
      while (stack.at(-1)?.indent !== undefined && (stack.at(-1)?.indent ?? -1) >= mappingIndent) stack.pop();
      addEntry(index + 1, mappingIndent, sequence[1] ?? '', stack);
      continue;
    }
    while (stack.at(-1)?.indent !== undefined && (stack.at(-1)?.indent ?? -1) >= contentStart) stack.pop();
    addEntry(index + 1, contentStart, text, stack);
  }
  return parsed;
}

export function findKubernetesCorrectionLocation(
  content: string,
  checkId: string,
  startLine: number | undefined,
  endLine: number | undefined,
): number | undefined {
  const correction = correctionLiterals[checkId];
  if (!correction || startLine === undefined || endLine === undefined
    || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine - startLine > maximumCauseLines
    || content.length > maximumFileCharacters || countYamlDocuments(content) === undefined || exceedsYamlLineLimit(content)) return undefined;

  try {
    loadAll(content, { maxAliasCount: 50 });
  } catch {
    return undefined;
  }
  const lines = parseYamlLines(content);
  if (!lines) return undefined;
  const kubernetesDocuments = new Set<number>();
  const headers = new Map<number, Set<string>>();
  for (const entry of lines) {
    if (entry.path.length !== 1 || (entry.key !== 'apiVersion' && entry.key !== 'kind') || !isYamlStringScalar(entry.value)) continue;
    const documentHeaders = headers.get(entry.document) ?? new Set<string>();
    documentHeaders.add(entry.key);
    headers.set(entry.document, documentHeaders);
  }
  for (const [document, documentHeaders] of headers) {
    if (documentHeaders.has('apiVersion') && documentHeaders.has('kind')) kubernetesDocuments.add(document);
  }
  const candidates = lines.filter(entry => {
    if (entry.line < startLine || entry.line > endLine || entry.key !== correction.key
      || !kubernetesDocuments.has(entry.document)
      || !new RegExp(`^${correction.current}(?:[ \t]+#.*)?$`).test(entry.value)) return false;
    let containerIndex = -1;
    for (let pathIndex = 0; pathIndex < entry.path.length; pathIndex += 1) {
      if (['containers', 'initContainers', 'ephemeralContainers'].includes(entry.path[pathIndex] ?? '')) containerIndex = pathIndex;
    }
    const securityContextIndex = entry.path.lastIndexOf('securityContext');
    if (containerIndex < 0 || !entry.path.slice(0, containerIndex).includes('spec')) return false;
    return entry.path[containerIndex + 1] === '[]'
      && securityContextIndex === containerIndex + 2
      && entry.path[securityContextIndex + 1] === correction.key;
  });
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (!candidate) return undefined;
  const parentPath = candidate.path.slice(0, -1).join('\0');
  const sameKeyInContext = lines.filter(entry => entry.document === candidate.document
    && entry.key === correction.key && entry.path.slice(0, -1).join('\0') === parentPath);
  if (sameKeyInContext.length !== 1) return undefined;
  return candidate.line;
}
