import { request } from 'node:https';
import { z } from 'zod';
import { defaultLicensePolicy, type LicensePolicy } from '@gotchu/contracts';
import type { LockedPackage } from './lockfiles.js';

const MAX_LICENSE_LOOKUPS = 200;
const MAX_LICENSE_RESPONSE_BYTES = 65_536;
const MAX_LICENSE_CACHE_ENTRIES = 500;
const LICENSE_CACHE_TTL_MS = 30 * 60 * 1_000;
const lookupPackageSchema = z.object({
  name: z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/),
}).strict();
const knownSpdxIds = new Set([
  '0BSD', 'AFL-3.0', 'Apache-1.1', 'Apache-2.0', 'Artistic-2.0', 'BSD-1-Clause', 'BSD-2-Clause', 'BSD-2-Clause-Patent', 'BSD-3-Clause', 'BSD-3-Clause-Clear', 'BSD-4-Clause',
  'BlueOak-1.0.0', 'BSL-1.0', 'BUSL-1.1', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'CDDL-1.0', 'CDDL-1.1', 'CECILL-2.1', 'ECL-2.0', 'EPL-1.0', 'EPL-2.0',
  'EUPL-1.1', 'EUPL-1.2', 'FTL', 'ISC', 'LPPL-1.3c', 'MIT', 'MPL-1.1', 'MPL-2.0', 'MS-PL', 'NCSA', 'OFL-1.1',
  'MIT-0', 'MulanPSL-2.0', 'OpenSSL', 'OSL-3.0', 'PostgreSQL', 'Python-2.0', 'Ruby', 'Unicode-3.0', 'Unlicense', 'UPL-1.0', 'WTFPL', 'Zlib', 'ZPL-2.1',
  'AGPL-1.0-only', 'AGPL-1.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'GPL-1.0-only', 'GPL-1.0-or-later', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'SSPL-1.0', 'Classpath-exception-2.0', 'GCC-exception-2.0', 'GCC-exception-3.1', 'LLVM-exception', 'OpenSSL-exception',
]);
const deprecatedSpdxIds: Readonly<Record<string, string>> = {
  'AGPL-1.0': 'AGPL-1.0-only', 'AGPL-1.0+': 'AGPL-1.0-or-later', 'AGPL-3.0': 'AGPL-3.0-only', 'AGPL-3.0+': 'AGPL-3.0-or-later',
  'BSD-2-Clause-FreeBSD': 'BSD-2-Clause', 'BSD-2-Clause-NetBSD': 'BSD-2-Clause',
  'GPL-1.0': 'GPL-1.0-only', 'GPL-1.0+': 'GPL-1.0-or-later', 'GPL-2.0': 'GPL-2.0-only', 'GPL-2.0+': 'GPL-2.0-or-later',
  'GPL-3.0': 'GPL-3.0-only', 'GPL-3.0+': 'GPL-3.0-or-later', 'LGPL-2.0': 'LGPL-2.0-only', 'LGPL-2.0+': 'LGPL-2.0-or-later',
  'LGPL-2.1': 'LGPL-2.1-only', 'LGPL-2.1+': 'LGPL-2.1-or-later', 'LGPL-3.0': 'LGPL-3.0-only', 'LGPL-3.0+': 'LGPL-3.0-or-later',
};
const deprecatedCompositeSpdxIds: Readonly<Record<string, string>> = {
  'gpl-2.0-with-autoconf-exception': 'GPL-2.0-only WITH Autoconf-exception-3.0',
  'gpl-2.0-with-bison-exception': 'GPL-2.0-only WITH Bison-exception-2.2',
  'gpl-2.0-with-classpath-exception': 'GPL-2.0-only WITH Classpath-exception-2.0',
  'gpl-2.0-with-font-exception': 'GPL-2.0-only WITH Font-exception-2.0',
  'gpl-2.0-with-gcc-exception': 'GPL-2.0-only WITH GCC-exception-2.0',
  'gpl-3.0-with-autoconf-exception': 'GPL-3.0-only WITH Autoconf-exception-3.0',
  'gpl-3.0-with-gcc-exception': 'GPL-3.0-only WITH GCC-exception-3.1',
};
const customLicenseRef = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/;

type LicenseNode =
  | { kind: 'id'; value: string }
  | { kind: 'with'; license: LicenseNode; exception: string }
  | { kind: 'and' | 'or'; terms: LicenseNode[] };

function normalizeId(value: string, allowException = false) {
  const normalized = deprecatedSpdxIds[value] ?? value;
  if (knownSpdxIds.has(normalized) || customLicenseRef.test(normalized)) return normalized;
  if (allowException && ['Autoconf-exception-3.0', 'Bison-exception-2.2', 'Font-exception-2.0', 'Linux-syscall-note'].includes(normalized)) return normalized;
  return null;
}

function tokenize(value: string): string[] | null {
  const tokens: string[] = []; const matcher = /\s*(\(|\)|[^\s()]+)\s*/gy; let offset = 0;
  while (offset < value.length) {
    matcher.lastIndex = offset; const match = matcher.exec(value); if (!match) return null;
    tokens.push(match[1] ?? ''); offset = matcher.lastIndex;
  }
  return tokens;
}

function parseSpdxExpression(value: string): LicenseNode | null {
  const tokens = tokenize(value); if (!tokens || tokens.length === 0 || tokens.length > 64) return null;
  let index = 0;
  const take = () => tokens[index++];
  const parsePrimary = (): LicenseNode | null => {
    const token = take(); if (!token) return null;
    if (token === '(') {
      const nested = parseOr(); if (!nested || take() !== ')') return null;
      return nested;
    }
    if (token === ')' || /^(?:AND|OR|WITH)$/i.test(token)) return null;
    const id = normalizeId(token); return id ? { kind: 'id', value: id } : null;
  };
  const parseWith = (): LicenseNode | null => {
    const license = parsePrimary(); if (!license) return null;
    if (tokens[index]?.toUpperCase() !== 'WITH') return license;
    if (license.kind !== 'id') return null;
    take(); const rawException = take(); if (!rawException) return null;
    const exception = normalizeId(rawException, true); return exception ? { kind: 'with', license, exception } : null;
  };
  const parseAnd = (): LicenseNode | null => {
    const terms = [parseWith()]; if (!terms[0]) return null;
    while (tokens[index]?.toUpperCase() === 'AND') { take(); const next = parseWith(); if (!next) return null; terms.push(next); }
    return terms.length === 1 ? terms[0] ?? null : { kind: 'and', terms: terms.filter((term): term is LicenseNode => term !== null) };
  };
  const parseOr = (): LicenseNode | null => {
    const terms = [parseAnd()]; if (!terms[0]) return null;
    while (tokens[index]?.toUpperCase() === 'OR') { take(); const next = parseAnd(); if (!next) return null; terms.push(next); }
    return terms.length === 1 ? terms[0] ?? null : { kind: 'or', terms: terms.filter((term): term is LicenseNode => term !== null) };
  };
  const tree = parseOr(); return tree && index === tokens.length ? tree : null;
}

function formatLicense(node: LicenseNode, parentPrecedence = 0): string {
  if (node.kind === 'id') return node.value;
  if (node.kind === 'with') return `${formatLicense(node.license, 3)} WITH ${node.exception}`;
  const precedence = node.kind === 'and' ? 2 : 1;
  const value = node.terms.map(term => formatLicense(term, precedence)).join(` ${node.kind.toUpperCase()} `);
  return precedence < parentPrecedence ? `(${value})` : value;
}

function licenseIds(node: LicenseNode): string[] {
  if (node.kind === 'id') return [node.value];
  if (node.kind === 'with') return licenseIds(node.license);
  return node.terms.flatMap(licenseIds);
}

export function normalizeLicenseExpression(raw: string | null | undefined) {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim(); if (!value || value.length > 200) return null;
  if (/^(?:UNLICENSED|SEE\s+LICENSE(?:\s+IN\s+.+)?|NOASSERTION|UNKNOWN)$/i.test(value)) return null;
  const canonical = deprecatedCompositeSpdxIds[value.toLowerCase()] ?? value;
  const parsed = parseSpdxExpression(canonical); return parsed ? formatLicense(parsed) : null;
}

export function normalizeLicensePolicy(policy: LicensePolicy): LicensePolicy {
  const normalizeGroup = (values: string[]) => values.map(value => {
    if (value === 'UNKNOWN') return value;
    const normalized = normalizeLicenseExpression(value);
    if (!normalized) throw new Error('invalid_license_policy_expression');
    return normalized;
  });
  const normalized = { allow: normalizeGroup(policy.allow), deny: normalizeGroup(policy.deny), review: normalizeGroup(policy.review) };
  if ([normalized.allow, normalized.deny, normalized.review].some(group => new Set(group).size !== group.length)) throw new Error('license_policy_duplicate');
  const allow = new Set(normalized.allow);
  if (normalized.deny.some(value => allow.has(value)) || normalized.review.some(value => allow.has(value))
    || normalized.deny.some(value => normalized.review.includes(value))) throw new Error('license_policy_conflict');
  return normalized;
}

export function evaluateLicensePolicy(expression: string | null, policy: LicensePolicy = defaultLicensePolicy): 'allowed' | 'review' | 'denied' {
  if (!expression) return 'review';
  const parsed = parseSpdxExpression(expression); if (!parsed) return 'review';
  const licenses = licenseIds(parsed); const denied = new Set(policy.deny); const reviewed = new Set(policy.review); const allowed = new Set(policy.allow);
  if (licenses.some(id => denied.has(id) || denied.has(expression))) return 'denied';
  if (licenses.some(id => reviewed.has(id)) || reviewed.has(expression)) return 'review';
  if (licenses.every(id => allowed.has(id)) || allowed.has(expression)) return 'allowed';
  return 'review';
}

export interface LicenseLookup { declaredLicense: string | null; complete: boolean }
export interface LicenseAdapter {
  lookup(packages: ReadonlyArray<Pick<LockedPackage, 'name' | 'version'>>, signal: AbortSignal): Promise<LicenseLookup[]>;
}

const registrySchema = z.object({ license: z.union([z.string().max(200), z.object({ type: z.string().max(200) }).passthrough()]).optional() }).passthrough();

function declaredValue(value: z.infer<typeof registrySchema>['license']): string | null {
  if (typeof value === 'string') return value;
  return value?.type ?? null;
}

function readRegistryLicense(name: string, version: string, parentSignal: AbortSignal): Promise<LicenseLookup> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5_000)]);
  return new Promise<LicenseLookup>(resolve => {
    const path = `/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    const req = request({ hostname: 'registry.npmjs.org', port: 443, path, method: 'GET', agent: false, rejectUnauthorized: true, signal, maxHeaderSize: 8_192, headers: { 'accept-encoding': 'identity', accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); resolve({ declaredLicense: null, complete: false }); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_LICENSE_RESPONSE_BYTES) { response.destroy(); resolve({ declaredLicense: null, complete: false }); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const parsed = registrySchema.safeParse(payload);
          resolve(parsed.success ? { declaredLicense: declaredValue(parsed.data.license), complete: true } : { declaredLicense: null, complete: false });
        } catch { resolve({ declaredLicense: null, complete: false }); }
      });
      response.on('error', () => resolve({ declaredLicense: null, complete: false }));
    });
    req.on('error', () => resolve({ declaredLicense: null, complete: false }));
    req.end();
  }).catch(error => {
    if (parentSignal.aborted) throw parentSignal.reason ?? error;
    return { declaredLicense: null, complete: false };
  });
}

export function createNpmLicenseAdapter(): LicenseAdapter {
  const cache = new Map<string, { value: LicenseLookup; expiresAt: number }>();
  return {
    async lookup(packages, signal) {
      if (packages.length > MAX_LICENSE_LOOKUPS) throw new Error('license_lookup_limit');
      const output: LicenseLookup[] = new Array(packages.length);
      const unique = new Map<string, { name: string; version: string; indexes: number[] }>();
      packages.forEach((item, index) => {
        const checked = lookupPackageSchema.parse(item);
        const key = `${checked.name}\0${checked.version}`; const previous = unique.get(key);
        if (previous) previous.indexes.push(index); else unique.set(key, { ...checked, indexes: [index] });
      });
      const pending = [...unique.values()].filter(item => {
        const key = `${item.name}\0${item.version}`; const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return false;
        cache.delete(key);
        return true;
      });
      for (let offset = 0; offset < pending.length; offset += 5) {
        const batch = pending.slice(offset, offset + 5);
        const results = await Promise.all(batch.map(item => readRegistryLicense(item.name, item.version, signal)));
        if (signal.aborted) throw signal.reason ?? new Error('license_lookup_aborted');
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index]; const result = results[index]; if (!item || !result) continue;
          const key = `${item.name}\0${item.version}`;
          if (result.complete) cache.set(key, { value: result, expiresAt: Date.now() + LICENSE_CACHE_TTL_MS });
          if (cache.size > MAX_LICENSE_CACHE_ENTRIES) cache.delete(cache.keys().next().value ?? key);
        }
      }
      for (const item of unique.values()) {
        const result = cache.get(`${item.name}\0${item.version}`)?.value ?? { declaredLicense: null, complete: false };
        for (const index of item.indexes) output[index] = result;
      }
      if (signal.aborted) throw signal.reason ?? new Error('license_lookup_aborted');
      return output;
    },
  };
}
