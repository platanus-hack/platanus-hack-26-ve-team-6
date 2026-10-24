import { load } from 'js-yaml';
import { z } from 'zod';
import type { CustomerRunInput, DependencyInventory } from '@gotchu/contracts';

export const MAX_LOCKFILE_BYTES = 1_048_576;
export const MAX_LOCKFILE_ENTRIES = 2_000;
export const MAX_INVENTORY_PACKAGES = 1_000;
const MAX_LOCKFILES = 50;
const MAX_COMPONENT_DEPENDENCIES = 100;
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const prereleasePart = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semverPattern = `(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${prereleasePart}(?:\\.${prereleasePart})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
const exactVersion = z.string().max(100).regex(new RegExp(`^${semverPattern}$`));
const pnpmVersionPrefix = new RegExp(`^(${semverPattern})(?=$|[_(])`);
const packageLockEntrySchema = z.object({
  name: packageName.optional(), version: z.string().optional(), link: z.boolean().optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(), devDependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(), license: z.unknown().optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
});
const npmLockSchema = z.object({ lockfileVersion: z.union([z.literal(2), z.literal(3)]), packages: z.record(z.string(), packageLockEntrySchema) });
const yamlPackageSchema = z.object({
  name: z.string().optional(), version: z.string().optional(), license: z.unknown().optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(), optionalDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const pnpmImporterSchema = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(), devDependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const pnpmLockSchema = z.object({
  lockfileVersion: z.union([z.string(), z.number()]),
  importers: z.record(z.string(), pnpmImporterSchema).optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(),
  packages: z.record(z.string(), yamlPackageSchema).optional(),
  snapshots: z.record(z.string(), yamlPackageSchema).optional(),
}).passthrough();

export interface LockedPackage {
  name: string;
  version: string;
  purl: string;
  location: string;
  sourceFile: string;
  relationship: 'direct' | 'transitive' | 'unknown';
  dependencies: string[];
  declaredLicense: string | null;
}

interface ParsedFile {
  packages: LockedPackage[];
  format: DependencyInventory['lockfiles'][number]['format'];
  state: DependencyInventory['lockfiles'][number]['state'];
  graphComplete: boolean;
  unknownCount: number;
}

function npmName(value: string) { return packageName.safeParse(value); }
function npmVersion(value: string | undefined) { return value === undefined ? null : exactVersion.safeParse(value).success ? value : null; }

export function npmPurl(name: string, version: string) {
  const encodedName = name.split('/').map(part => encodeURIComponent(part)).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function declaredLicense(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string') return value.type.slice(0, 200);
  return null;
}

function jsonDepthIsBounded(value: string, maxDepth = 50) {
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { depth++; if (depth > maxDepth) return false; }
    else if (char === '}' || char === ']') depth--;
  }
  return depth === 0 && !quoted;
}

function yamlDepthIsBounded(value: string, maxDepth = 50) {
  const lines = value.split('\n');
  if (lines.length > 40_000) return false;
  const indentationLevels: number[] = [];
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indentation = /^ */.exec(line)?.[0].length ?? 0;
    while ((indentationLevels.at(-1) ?? -1) > indentation) indentationLevels.pop();
    if (indentationLevels.at(-1) !== indentation) indentationLevels.push(indentation);
    if (indentationLevels.length > maxDepth) return false;
  }
  let flowDepth = 0;
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (const line of lines) {
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote === 'double') {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quote = null;
        continue;
      }
      if (quote === 'single') {
        if (char === "'" && line[index + 1] === "'") index++;
        else if (char === "'") quote = null;
        continue;
      }
      if (char === '"') quote = 'double';
      else if (char === "'") quote = 'single';
      else if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) break;
      else if (char === '[' || char === '{') { flowDepth++; if (flowDepth > maxDepth) return false; }
      else if (char === ']' || char === '}') { flowDepth--; if (flowDepth < 0) return false; }
    }
    if (quote !== null) return false;
  }
  return flowDepth === 0;
}

function rootManifestDependencies(files: NonNullable<CustomerRunInput['source']>['files']) {
  const result = new Map<string, Set<string>>();
  const manifests = files.filter(file => file.path.split('/').at(-1) === 'package.json');
  let determinable = manifests.length > 0 && manifests.length <= MAX_LOCKFILES;
  let dependencyCount = 0;
  for (const file of manifests.slice(0, MAX_LOCKFILES)) {
    if (dependencyCount >= MAX_LOCKFILE_ENTRIES) { determinable = false; break; }
    if (Buffer.byteLength(file.content, 'utf8') > 65_536 || !jsonDepthIsBounded(file.content)) { determinable = false; continue; }
    try {
      const root: unknown = JSON.parse(file.content);
      if (typeof root !== 'object' || root === null || Array.isArray(root)) { determinable = false; continue; }
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        if (dependencyCount >= MAX_LOCKFILE_ENTRIES) { determinable = false; break; }
        const values = Reflect.get(root, field);
        if (values === undefined) continue;
        if (typeof values !== 'object' || values === null || Array.isArray(values)) { determinable = false; continue; }
        for (const [name, range] of Object.entries(values)) {
          if (dependencyCount >= MAX_LOCKFILE_ENTRIES) { determinable = false; break; }
          dependencyCount++;
          if (!npmName(name).success || typeof range !== 'string' || range.length > 256) { determinable = false; continue; }
          const ranges = result.get(name) ?? new Set<string>(); ranges.add(range); result.set(name, ranges);
        }
      }
    } catch { determinable = false; /* A manifest is only a directness hint; the lockfile remains authoritative. */ }
  }
  return { dependencies: result, determinable };
}

function buildPackage(nameValue: unknown, versionValue: unknown, sourceFile: string, location: string, relationship: LockedPackage['relationship'], licenseValue: unknown): LockedPackage | null {
  if (typeof nameValue !== 'string') return null;
  const name = npmName(nameValue); const version = typeof versionValue === 'string' ? npmVersion(versionValue) : null;
  if (!name.success || !version || location.length > 1_024) return null;
  return { name: name.data, version, purl: npmPurl(name.data, version), sourceFile, location, relationship, dependencies: [], declaredLicense: declaredLicense(licenseValue) };
}

function parseNpmLock(sourceFile: string, content: string): ParsedFile {
  if (Buffer.byteLength(content, 'utf8') > MAX_LOCKFILE_BYTES || !jsonDepthIsBounded(content)) {
    return { packages: [], format: 'unsupported', state: 'unavailable', graphComplete: false, unknownCount: 1 };
  }
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return { packages: [], format: 'unsupported', state: 'unavailable', graphComplete: false, unknownCount: 1 }; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { packages: [], format: 'unsupported', state: 'unavailable', graphComplete: false, unknownCount: 1 };
  }
  const version = Reflect.get(value, 'lockfileVersion');
  if (version !== 2 && version !== 3) {
    return { packages: [], format: 'unsupported', state: 'unsupported', graphComplete: false, unknownCount: 1 };
  }
  const format = version === 2 ? 'npm-v2' : 'npm-v3';
  const packageEntries: unknown = Reflect.get(value, 'packages');
  if (typeof packageEntries !== 'object' || packageEntries === null || Array.isArray(packageEntries) || Object.keys(packageEntries).length > MAX_LOCKFILE_ENTRIES) {
    return { packages: [], format, state: 'unavailable', graphComplete: false, unknownCount: 1 };
  }
  let parsed: z.infer<typeof npmLockSchema>;
  try {
    parsed = npmLockSchema.parse(value);
  } catch { return { packages: [], format, state: 'unavailable', graphComplete: false, unknownCount: 1 }; }
  const direct = new Set([...Object.keys(parsed.packages['']?.dependencies ?? {}), ...Object.keys(parsed.packages['']?.devDependencies ?? {}), ...Object.keys(parsed.packages['']?.optionalDependencies ?? {})]);
  const byPath = new Map<string, LockedPackage>();
  let unknownCount = 0; let graphComplete = true;
  for (const [path, entry] of Object.entries(parsed.packages).sort(([left], [right]) => left.localeCompare(right))) {
    if (!path) continue;
    const inferred = path.split('node_modules/').at(-1) ?? '';
    const component = buildPackage(entry.name ?? inferred, entry.version, sourceFile, `${sourceFile}:${path}`, path === `node_modules/${inferred}` && direct.has(inferred) ? 'direct' : 'transitive', entry.license);
    if (entry.link || !path.includes('node_modules/') || !component) { unknownCount++; continue; }
    if (Object.keys(entry.peerDependencies ?? {}).length > 0) graphComplete = false;
    byPath.set(path, component);
  }
  const resolve = (path: string, dependency: string) => {
    let context = path;
    while (context) {
      const nested = byPath.get(`${context}/node_modules/${dependency}`);
      if (nested) return nested.purl;
      const parentModules = context.lastIndexOf('/node_modules/');
      if (parentModules < 0) break;
      context = context.slice(0, parentModules);
    }
    return byPath.get(`node_modules/${dependency}`)?.purl;
  };
  for (const [path, entry] of Object.entries(parsed.packages)) {
    const component = byPath.get(path); if (!component) continue;
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const resolved = resolve(path, dependency);
      if (resolved && component.dependencies.length < MAX_COMPONENT_DEPENDENCIES) component.dependencies.push(resolved); else graphComplete = false;
    }
  }
  for (const component of byPath.values()) component.dependencies = [...new Set(component.dependencies)].slice(0, 100);
  const root = parsed.packages[''];
  if (!root) {
    graphComplete = false;
    for (const component of byPath.values()) component.relationship = 'unknown';
  } else {
    for (const dependency of Object.keys({ ...root.dependencies, ...root.devDependencies, ...root.optionalDependencies })) {
      if (!byPath.has(`node_modules/${dependency}`)) graphComplete = false;
    }
  }
  graphComplete = graphComplete && unknownCount === 0;
  return { packages: [...byPath.values()], format, state: unknownCount ? 'unavailable' : 'inspected', graphComplete, unknownCount };
}

function pnpmPackageId(raw: string): { name: string; version: string } | null {
  const value = raw.replace(/^\//, '').replace(/\([^)]*\)/g, '');
  if (!value || value.startsWith('file:') || value.startsWith('link:') || value.startsWith('workspace:') || value.startsWith('npm:')) return null;
  if (value.startsWith('@')) {
    const scopeEnd = value.indexOf('/'); if (scopeEnd < 0) return null;
    const versionSeparator = value.lastIndexOf('@');
    if (versionSeparator > scopeEnd) return { name: value.slice(0, versionSeparator), version: value.slice(versionSeparator + 1) };
    const secondSlash = value.indexOf('/', scopeEnd + 1);
    if (secondSlash < 0) return null;
    return { name: value.slice(0, secondSlash), version: value.slice(secondSlash + 1) };
  }
  const at = value.lastIndexOf('@');
  if (at > 0) {
    const version = pnpmVersionPrefix.exec(value.slice(at + 1))?.[1];
    return version ? { name: value.slice(0, at), version } : null;
  }
  const slash = value.lastIndexOf('/');
  if (slash > 0) {
    const version = pnpmVersionPrefix.exec(value.slice(slash + 1))?.[1];
    return version ? { name: value.slice(0, slash), version } : null;
  }
  return null;
}

function pnpmRefVersion(value: unknown) {
  const ref = typeof value === 'string' ? value : typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'string' ? value.version : null;
  if (!ref) return null;
  const clean = ref.replace(/^npm:/, '').replace(/\([^)]*\)/g, '');
  const parsed = pnpmPackageId(clean);
  return npmVersion(parsed?.version ?? pnpmVersionPrefix.exec(clean)?.[1]);
}

function parsePnpmLock(sourceFile: string, content: string): ParsedFile {
  if (Buffer.byteLength(content, 'utf8') > MAX_LOCKFILE_BYTES || !yamlDepthIsBounded(content)) {
    return { packages: [], format: 'pnpm-v9', state: 'unavailable', graphComplete: false, unknownCount: 1 };
  }
  let parsed: z.infer<typeof pnpmLockSchema>;
  try {
    const yaml: unknown = load(content, { maxAliasCount: 50 });
    if (typeof yaml !== 'object' || yaml === null) throw new Error('pnpm_yaml_not_object');
    const packageCount = Object.keys(Reflect.get(yaml, 'packages') ?? {}).length;
    const snapshotCount = Object.keys(Reflect.get(yaml, 'snapshots') ?? {}).length;
    if (packageCount > MAX_LOCKFILE_ENTRIES || snapshotCount > MAX_LOCKFILE_ENTRIES
      || Object.keys(Reflect.get(yaml, 'importers') ?? {}).length > MAX_LOCKFILES) throw new Error('pnpm_entry_limit');
    parsed = pnpmLockSchema.parse(yaml);
  } catch { return { packages: [], format: 'pnpm-v9', state: 'unavailable', graphComplete: false, unknownCount: 1 }; }
  const major = String(parsed.lockfileVersion).split('.')[0];
  if (major !== '6' && major !== '9') return { packages: [], format: 'unsupported', state: 'unsupported', graphComplete: false, unknownCount: 1 };
  const format = major === '6' ? 'pnpm-v6' : 'pnpm-v9';
  const rawPackages = parsed.packages ?? {};
  const dependencySnapshots = parsed.snapshots ?? rawPackages;
  const packages: LockedPackage[] = []; const rawByPurl = new Map<string, string[]>();
  let unknownCount = 0; let graphComplete = true;
  for (const [rawId, entry] of Object.entries(rawPackages)) {
    const id = pnpmPackageId(rawId); const metadataName = entry.name ?? id?.name; const metadataVersion = entry.version ?? id?.version;
    const component = buildPackage(metadataName, metadataVersion, sourceFile, `${sourceFile}:${rawId}`, 'transitive', entry.license);
    if (!component) { unknownCount++; continue; }
    if (Object.keys(entry.peerDependencies ?? {}).length > 0 || /\([^)]*\)/.test(rawId)) graphComplete = false;
    packages.push(component);
    const matching = rawByPurl.get(component.purl) ?? []; matching.push(rawId); rawByPurl.set(component.purl, matching);
  }
  const direct = new Set<string>();
  const importers = Object.values(parsed.importers ?? {});
  const rootDependencyGroups = major === '6'
    ? [{ dependencies: parsed.dependencies, devDependencies: parsed.devDependencies, optionalDependencies: parsed.optionalDependencies }]
    : importers;
  if (rootDependencyGroups.length === 0) graphComplete = false;
  let directDependencyCount = 0;
  let directnessUnknown = false;
  for (const importer of rootDependencyGroups) {
    for (const group of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        directDependencyCount++;
        const version = pnpmRefVersion(spec);
        if (!version) { graphComplete = false; directnessUnknown = true; unknownCount++; continue; }
        const purl = npmPurl(name, version); if (packages.some(component => component.purl === purl)) direct.add(purl);
        else { graphComplete = false; unknownCount++; }
      }
    }
  }
  if (directDependencyCount === 0 && packages.length > 0) { graphComplete = false; directnessUnknown = true; }
  for (const component of packages) {
    if (direct.has(component.purl)) component.relationship = 'direct';
    else if (rootDependencyGroups.length === 0 || directnessUnknown) component.relationship = 'unknown';
  }
  for (const component of packages) {
    const rawIds = rawByPurl.get(component.purl) ?? [];
    const snapshot = rawIds.map(id => dependencySnapshots[id]).find((value): value is z.infer<typeof yamlPackageSchema> => value !== undefined);
    if (!snapshot) continue;
    for (const [name, ref] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
      if (typeof ref === 'string' && /\([^)]*\)/.test(ref)) graphComplete = false;
      const version = pnpmRefVersion(ref); const target = version ? npmPurl(name, version) : null;
      if (target && packages.some(candidate => candidate.purl === target) && component.dependencies.length < MAX_COMPONENT_DEPENDENCIES) component.dependencies.push(target);
      else graphComplete = false;
    }
  }
  for (const component of packages) component.dependencies = [...new Set(component.dependencies)].slice(0, MAX_COMPONENT_DEPENDENCIES);
  graphComplete = graphComplete && unknownCount === 0;
  const state = unknownCount ? 'unavailable' : 'inspected';
  return { packages, format, state, graphComplete, unknownCount };
}

interface YarnEntry { selectors: string[]; version: string | null; dependencies: Map<string, string>; license: string | null; incompleteGraph: boolean }
function splitYarnSelectors(value: string) {
  const selectors: string[] = []; let quote = ''; let current = '';
  for (const char of value) {
    if (quote) { if (char === quote) quote = ''; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ',') { if (current.trim()) selectors.push(current.trim()); current = ''; }
    else current += char;
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function yarnDescriptor(value: string) {
  const selector = value.replace(/^['"]|['"]$/g, '');
  const at = selector.lastIndexOf('@'); if (at <= 0) return null;
  const name = selector.slice(0, at); let range = selector.slice(at + 1);
  if (/^npm:[^@/]+@/.test(range)) return null;
  range = range.replace(/^(?:npm|patch|portal|workspace):/, '');
  if (!npmName(name).success || !range || range === '*' || range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) return null;
  return { name, range };
}

function parseYarnEntries(content: string) {
  const entries: YarnEntry[] = []; let current: YarnEntry | null = null; let section: 'dependencies' | 'optionalDependencies' | 'peerDependencies' | 'metadata' | null = null;
  let metadataBlock = false; let malformed = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line) && line.endsWith(':')) {
      if (current) entries.push(current);
      if (line === '__metadata:') { current = null; section = null; metadataBlock = true; continue; }
      const selectors = splitYarnSelectors(line.slice(0, -1));
      if (metadataBlock) metadataBlock = false;
      if (selectors.length === 0 || selectors.some(selector => !selector.trim())) { malformed = true; current = null; continue; }
      current = { selectors, version: null, dependencies: new Map(), license: null, incompleteGraph: false }; section = null; continue;
    }
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (metadataBlock && indent === 2 && /^\s{2}[A-Za-z][A-Za-z0-9_-]*:\s*[^:]+\s*$/.test(line)) continue;
    if (!current) { malformed = true; continue; }
    const version = /^\s{2}version(?::\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (version) { current.version = version[1] ?? version[2] ?? version[3] ?? null; section = null; continue; }
    const license = /^\s{2}license(?::\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (license) { current.license = license[1] ?? license[2] ?? license[3] ?? null; section = null; continue; }
    if (/^\s{2}(?:resolved|integrity)\s+(?:"[^"]+"|'[^']+'|[^\s#]+)\s*$/.test(line)) { section = null; continue; }
    const property = /^\s{2}([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (property) {
      const key = property[1]; const scalar = property[2] ?? '';
      if (!key) { malformed = true; section = null; continue; }
      if (key === 'dependencies' || key === 'optionalDependencies' || key === 'peerDependencies') {
        section = key;
        if (key === 'peerDependencies') current.incompleteGraph = true;
        if (scalar) malformed = true;
      } else if (key === 'dependenciesMeta' || key === 'peerDependenciesMeta') section = 'metadata';
      else if (['resolved', 'integrity', 'resolution', 'checksum', 'languageName', 'linkType', 'conditions', 'bin'].includes(key)) section = null;
      else { malformed = true; section = null; }
      continue;
    }
    if (section === 'metadata' && indent >= 4) continue;
    if (section === 'dependencies' || section === 'optionalDependencies' || section === 'peerDependencies') {
      const berry = /^\s{4}("[^"]+"|'[^']+'|[^:]+):\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/.exec(line);
      const classic = /^\s{4}(.+?)\s+(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/.exec(line);
      const dependency = berry ?? classic;
      if (!dependency) { malformed = true; current.incompleteGraph = true; continue; }
      const name = dependency[1]?.replace(/^['"]|['"]$/g, '') ?? '';
      const range = dependency[2] ?? dependency[3] ?? dependency[4] ?? '';
      if (!npmName(name).success || !range || range.length > 256) { malformed = true; current.incompleteGraph = true; continue; }
      if (section === 'peerDependencies') { current.incompleteGraph = true; continue; }
      if (current.dependencies.size >= 100) current.incompleteGraph = true;
      else current.dependencies.set(name, range);
      continue;
    }
    malformed = true;
  }
  if (current) entries.push(current);
  return { entries, malformed };
}

function parseYarnLock(sourceFile: string, content: string, directDependencies: Map<string, Set<string>>, directnessDeterminable: boolean): ParsedFile {
  if (Buffer.byteLength(content, 'utf8') > MAX_LOCKFILE_BYTES || content.split('\n').length > 40_000) {
    return { packages: [], format: 'yarn-v1', state: 'unavailable', graphComplete: false, unknownCount: 1 };
  }
  const berry = /^__metadata:/m.test(content);
  const format = berry ? 'yarn-berry' : 'yarn-v1';
  const parsedEntries = parseYarnEntries(content);
  const entries = parsedEntries.entries;
  if (entries.length > MAX_LOCKFILE_ENTRIES) return { packages: [], format, state: 'unavailable', graphComplete: false, unknownCount: 1 };
  const packages: LockedPackage[] = []; const selectorToPackage = new Map<string, LockedPackage>();
  let unknownCount = parsedEntries.malformed || entries.length === 0 ? 1 : 0;
  for (const entry of entries) {
    const version = npmVersion(entry.version ?? undefined); const descriptors = entry.selectors.map(yarnDescriptor).filter((item): item is NonNullable<typeof item> => item !== null);
    if (!version || descriptors.length === 0) { unknownCount++; continue; }
    const names = new Set(descriptors.map(item => item.name));
    if (names.size !== 1) { unknownCount++; continue; }
    const name = [...names][0]; if (!name) { unknownCount++; continue; }
    const isDirect = descriptors.some(item => directDependencies.get(item.name)?.has(item.range));
    const directRangeUnmatched = descriptors.some(item => directDependencies.has(item.name)) && !isDirect;
    const relationship = isDirect ? 'direct' : directnessDeterminable && !directRangeUnmatched ? 'transitive' : 'unknown';
    const component = buildPackage(name, version, sourceFile, `${sourceFile}:${entry.selectors.join(', ')}`, relationship, entry.license);
    if (!component) { unknownCount++; continue; }
    packages.push(component);
    for (const descriptor of descriptors) selectorToPackage.set(`${descriptor.name}\0${descriptor.range}`, component);
  }
  let graphComplete = unknownCount === 0 && entries.every(entry => !entry.incompleteGraph);
  for (const entry of entries) {
    const descriptor = entry.selectors.map(yarnDescriptor).find((item): item is NonNullable<typeof item> => item !== null);
    const component = descriptor ? selectorToPackage.get(`${descriptor.name}\0${descriptor.range}`) : undefined;
    if (!component) continue;
    for (const [dependency, range] of entry.dependencies) {
      const target = selectorToPackage.get(`${dependency}\0${range.replace(/^(?:npm):/, '')}`);
      if (target && component.dependencies.length < MAX_COMPONENT_DEPENDENCIES) component.dependencies.push(target.purl); else graphComplete = false;
    }
  }
  for (const component of packages) {
    component.dependencies = [...new Set(component.dependencies)].slice(0, MAX_COMPONENT_DEPENDENCIES);
  }
  for (const [name, range] of directDependencies) {
    if (![...selectorToPackage.keys()].some(key => key === `${name}\0${range}`)) graphComplete = false;
  }
  if (!directnessDeterminable) graphComplete = false;
  return { packages, format, state: unknownCount ? 'unavailable' : 'inspected', graphComplete: graphComplete && unknownCount === 0, unknownCount };
}

const lockFileKind = (path: string): 'npm' | 'pnpm' | 'yarn' | 'unsupported' | null => {
  const base = path.split('/').at(-1)?.toLowerCase();
  if (base === 'package-lock.json') return 'npm';
  if (base === 'pnpm-lock.yaml') return 'pnpm';
  if (base === 'yarn.lock') return 'yarn';
  if (base && ['bun.lock', 'bun.lockb', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'pipfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'gradle.lockfile'].includes(base)) return 'unsupported';
  return null;
};

export function parseLockfile(source: NonNullable<CustomerRunInput['source']>) {
  const files = source.files.filter(file => lockFileKind(file.path) !== null);
  const manifest = rootManifestDependencies(source.files);
  const inventory: LockedPackage[] = []; const unknown: string[] = []; const lockfiles: DependencyInventory['lockfiles'] = [];
  let unknownCount = 0; let graphComplete = files.length > 0;
  for (const file of files.slice(0, MAX_LOCKFILES)) {
    const kind = lockFileKind(file.path); if (!kind) continue;
    let parsed: ParsedFile;
    if (kind === 'npm') parsed = parseNpmLock(file.path, file.content);
    else if (kind === 'pnpm') parsed = parsePnpmLock(file.path, file.content);
    else if (kind === 'yarn') parsed = parseYarnLock(file.path, file.content, manifest.dependencies, manifest.determinable);
    else parsed = { packages: [], format: 'unsupported', state: 'unsupported', graphComplete: false, unknownCount: 1 };
    const retainedPackages = parsed.packages.slice(0, Math.max(0, MAX_INVENTORY_PACKAGES - inventory.length));
    const omittedPackages = parsed.packages.length - retainedPackages.length;
    const state = omittedPackages > 0 ? 'unavailable' : parsed.state;
    if (lockfiles.length < 50) lockfiles.push({ sourceFile: file.path, format: parsed.format, state, packageCount: Math.min(parsed.packages.length, MAX_LOCKFILE_ENTRIES) });
    if (parsed.unknownCount > 0) {
      unknownCount += parsed.unknownCount;
      if (unknown.length < 50) unknown.push(file.path);
    }
    if (omittedPackages > 0) {
      unknownCount += omittedPackages;
      if (unknown.length < 50) unknown.push(file.path);
    }
    graphComplete = graphComplete && parsed.graphComplete && omittedPackages === 0;
    inventory.push(...retainedPackages);
  }
  if (files.length > MAX_LOCKFILES) {
    unknownCount += files.length - MAX_LOCKFILES;
    graphComplete = false;
    if (unknown.length < 50) unknown.push('lockfile_record_limit');
  }
  let remainingEdges = 5_000;
  for (const component of inventory) {
    if (component.dependencies.length > remainingEdges) { component.dependencies = component.dependencies.slice(0, remainingEdges); graphComplete = false; }
    remainingEdges -= component.dependencies.length;
  }
  unknownCount = Math.min(unknownCount, 100_000);
  return { inventory, unknown, unknownCount, lockfiles, found: files.length > 0, complete: files.length > 0 && unknownCount === 0, graphComplete: files.length > 0 && graphComplete };
}
