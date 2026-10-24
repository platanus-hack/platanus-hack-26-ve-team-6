import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { runtimeAttackEvidenceSchema, runtimeAttackKindSchema } from '@gotchu/contracts';

export type AttackKind = (typeof runtimeAttackKindSchema)['_output'];
export type Evidence = (typeof runtimeAttackEvidenceSchema)['_output'];

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function extractStrings(value: unknown, output: string[], visited: Set<object>, depth = 0): void {
  if (output.length >= 128 || depth > 6) return;
  if (typeof value === 'string') {
    if (value.length > 0) output.push(value.slice(0, 2_048));
    return;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  try {
    for (const child of Array.isArray(value) ? value : Object.values(value)) extractStrings(child, output, visited, depth + 1);
  } catch { /* An unusual request object must not break the host handler. */ }
}

export function routeTemplate(route: string): string {
  const normalized = route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
  return /^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/.test(normalized) ? normalized : '/unknown';
}

export function requestValues(rawUrl: string, values: unknown[] = []): string[] {
  const result: string[] = [];
  try {
    const url = new URL(rawUrl, 'http://gotchu.invalid');
    for (const segment of url.pathname.split('/')) {
      if (!segment) continue;
      try { result.push(decodeURIComponent(segment)); } catch { result.push(segment); }
    }
    for (const value of url.searchParams.values()) result.push(value);
  } catch { /* Keep an unknown route and no URL inputs for malformed request URLs. */ }
  for (const value of values) extractStrings(value, result, new Set());
  return result.slice(0, 128);
}

export function requestRoute(rawUrl: string): string {
  try {
    const parts = new URL(rawUrl, 'http://gotchu.invalid').pathname.split('/').filter(Boolean);
    if (parts.length > 1) {
      const last = parts.length - 1;
      const segment = parts[last] ?? '';
      if (/^(?:\d+|[a-f\d]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(segment)) parts[last] = '{param}';
    }
    return routeTemplate(`/${parts.join('/')}`);
  } catch { return '/unknown'; }
}

export function inputFlowsInto(text: string, inputs: readonly string[]): boolean {
  return inputs.some(input => input.length > 0 && (text.includes(input) || text.includes(encodeURIComponent(input))));
}

export function sqlEvidence(input: string): Evidence | null {
  if (/(?:['"`])\s*(?:or|and)\s+['"]?\w+['"]?\s*=\s*['"]?\w+['"]?/i.test(input)) return 'sql_boolean_tautology';
  if (/\bunion\s+(?:all\s+)?select\b/i.test(input)) return 'sql_union_select';
  if (/;\s*(?:select|insert|update|delete|drop|alter|truncate|exec)\b/i.test(input)) return 'sql_statement_chain';
  if (/(?:['"`])\s*(?:--|\/\*)/.test(input)) return 'sql_comment_termination';
  return null;
}

export function outsideRoot(candidate: string, root: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(base, candidate);
  return resolved !== base && !resolved.startsWith(`${base}${path.sep}`);
}

export function shellEvidence(input: string): Evidence | null {
  return /(?:&&|\|\||[;|`\n\r]|\$\()/.test(input) ? 'shell_operator_in_input' : null;
}

function privateAddress(input: string): boolean {
  const address = input.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? input;
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice(7);
    if (mapped.includes('.')) return privateAddress(mapped);
    const words = mapped.split(':');
    const high = Number.parseInt(words.at(-2) ?? '', 16);
    const low = Number.parseInt(words.at(-1) ?? '', 16);
    if (Number.isFinite(high) && Number.isFinite(low)) return privateAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  if (isIP(address) === 6) return address === '::' || address === '::1' || /^(?:fc|fd|fe[89ab]|ff)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
    || a >= 224;
}

export async function resolvesPrivate(hostname: string): Promise<boolean> {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  if (privateAddress(normalized)) return true;
  if (isIP(normalized) !== 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 300); });
  const resolved = lookup(normalized, { all: true, verbatim: true }).then(answers => answers.some(answer => privateAddress(answer.address))).catch(() => false);
  return Promise.race([resolved, timedOut]).finally(() => clearTimeout(timer));
}
