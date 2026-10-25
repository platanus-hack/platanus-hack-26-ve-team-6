import { createHash } from 'node:crypto';
import { osvAdvisoryMetadataSchema, type CustomerSourceSnapshot, type OsvAdvisoryMetadata } from '@gotchu/contracts';
import { z } from 'zod';
import { canonicalJson, sha256 } from './core.js';
import { npmPackumentSchema, packageNameSchema as packageName, selectNpmFixVersion, type NpmFixReason } from './npm-fix-version.js';
export { createNpmRegistryAdapter, selectNpmFixVersion } from './npm-fix-version.js';
export type { NpmFixReason, NpmRegistryPort } from './npm-fix-version.js';

const packageEntrySchema = z.object({
  name: packageName.optional(),
  version: z.string().max(100).optional(),
  resolved: z.string().max(2_048).optional(),
  integrity: z.string().max(512).optional(),
  link: z.boolean().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z.record(z.string(), z.unknown()).optional(),
  engines: z.unknown().optional(),
}).passthrough();
const lockfileSchema = z.object({
  name: z.string().max(214).optional(),
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), packageEntrySchema),
  dependencies: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const installScriptsSchema = z.object({
  preinstall: z.string().optional(),
  install: z.string().optional(),
  postinstall: z.string().optional(),
});
const legacyDependencySchema = z.object({
  version: z.string(),
  resolved: z.string(),
  integrity: z.string(),
  requires: z.record(z.string(), z.string()).optional(),
}).passthrough();
export type NpmFixResolution =
  | { status: 'guidance_only'; reason: NpmFixReason }
  | { status: 'ready'; packageName: string; fromVersion: string; toVersion: string; relationship: 'direct'; section: 'dependencies' | 'devDependencies' | 'optionalDependencies'; packageJsonPath: string; packageLockPath: string; files: readonly { path: string; content: string }[]; lockfileSha256: string; patchSha256: string };

function equalRecord(left: unknown, right: unknown): boolean { return canonicalJson(left ?? {}) === canonicalJson(right ?? {}); }
function isSha512Integrity(value: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  try { return Buffer.from(value.slice('sha512-'.length), 'base64').byteLength === 64; }
  catch { return false; }
}

function skipWhitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? '')) index++;
  return index;
}
function stringEnd(source: string, start: number): number | undefined {
  if (source[start] !== '"') return undefined;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '"') return index + 1;
  }
  return undefined;
}
function valueEnd(source: string, start: number): number | undefined {
  const index = skipWhitespace(source, start);
  if (source[index] === '"') return stringEnd(source, index);
  if (source[index] !== '{' && source[index] !== '[') {
    let end = index;
    while (end < source.length && !/[\s,}\]]/.test(source[end] ?? '')) end++;
    return end > index ? end : undefined;
  }
  const stack = [source[index] === '{' ? '}' : ']'];
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (character === '"') { const end = stringEnd(source, cursor); if (!end) return undefined; cursor = end - 1; continue; }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return undefined;
      if (stack.length === 0) return cursor + 1;
    }
  }
  return undefined;
}
function pathRange(source: string, path: readonly string[], start = 0): { start: number; end: number } | undefined {
  const index = skipWhitespace(source, start);
  if (source[index] !== '{') return undefined;
  let cursor = index + 1;
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === '}') return undefined;
    if (source[cursor] !== '"') return undefined;
    const keyEnd = stringEnd(source, cursor);
    if (!keyEnd) return undefined;
    const key: unknown = JSON.parse(source.slice(cursor, keyEnd));
    cursor = skipWhitespace(source, keyEnd);
    if (source[cursor] !== ':') return undefined;
    const valueStart = skipWhitespace(source, cursor + 1);
    const end = valueEnd(source, valueStart);
    if (!end) return undefined;
    if (key === path[0]) {
      if (path.length === 1) return { start: valueStart, end };
      const child = pathRange(source, path.slice(1), valueStart);
      if (child) return child;
    }
    cursor = skipWhitespace(source, end);
    if (source[cursor] !== ',') return undefined;
    cursor++;
  }
}
function replaceJsonPath(source: string, path: readonly string[], value: string): string | undefined {
  const range = pathRange(source, path);
  if (!range || source[range.start] !== '"') return undefined;
  return source.slice(0, range.start) + JSON.stringify(value) + source.slice(range.end);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) return '{' + Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function directSection(manifest: Record<string, unknown>, lockRoot: Record<string, unknown>, name: string): { section: 'dependencies'|'devDependencies'|'optionalDependencies'; declaration: string } | undefined {
  const matches = (['dependencies','devDependencies','optionalDependencies'] as const).flatMap(section => {
    const packageGroup = manifest[section]; const lockGroup = lockRoot[section];
    if (typeof packageGroup !== 'object' || packageGroup === null || Array.isArray(packageGroup)) return [];
    const declaration = (packageGroup as Record<string, unknown>)[name];
    if (typeof declaration !== 'string') return [];
    if (typeof lockGroup !== 'object' || lockGroup === null || Array.isArray(lockGroup) || (lockGroup as Record<string, unknown>)[name] !== declaration) return [];
    return [{ section, declaration }];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function prepareNpmDependencyPatch(input: {
  source: CustomerSourceSnapshot; name: string; fromVersion: string; location: string;
  advisories: readonly OsvAdvisoryMetadata[]; packument: unknown;
}): NpmFixResolution {
  if (!packageName.safeParse(input.name).success || input.advisories.length === 0) return { status: 'guidance_only', reason: 'advisory_metadata_missing' };
  const location = /^(.*package-lock\.json):(node_modules\/.+)$/.exec(input.location);
  if (!location || location[2] !== `node_modules/${input.name}`) {
    return { status: 'guidance_only', reason: location && location[2]?.includes('node_modules/') ? 'transitive_override_not_supported' : 'lockfile_unsupported' };
  }
  const packageLockPath = location[1];
  if (!packageLockPath || packageLockPath !== 'package-lock.json') return { status: 'guidance_only', reason: 'lockfile_unsupported' };
  const packageJsonPath = packageLockPath.replace(/package-lock\.json$/, 'package.json');
  const manifestFile = input.source.files.find(file => file.path === packageJsonPath);
  const lockFile = input.source.files.find(file => file.path === packageLockPath);
  if (!manifestFile || !lockFile || input.source.files.filter(file => /(?:^|\/)package-lock\.json$/.test(file.path)).length !== 1) return { status: 'guidance_only', reason: 'source_incomplete' };
  let manifest: Record<string, unknown>;
  let lockfile: z.infer<typeof lockfileSchema>;
  try {
    const manifestJson: unknown = JSON.parse(manifestFile.content);
    const parsedManifest = z.record(z.string(), z.unknown()).safeParse(manifestJson);
    const lockJson: unknown = JSON.parse(lockFile.content);
    const parsedLock = lockfileSchema.safeParse(lockJson);
    if (!parsedManifest.success || !parsedLock.success) return { status: 'guidance_only', reason: 'lockfile_unsupported' };
    manifest = parsedManifest.data; lockfile = parsedLock.data;
  } catch { return { status: 'guidance_only', reason: 'lockfile_unsupported' }; }
  if (manifest.workspaces !== undefined || Object.keys(lockfile.packages).some(packagePath => packagePath !== '' && !packagePath.startsWith('node_modules/'))) {
    return { status: 'guidance_only', reason: 'workspace_not_supported' };
  }
  const path = `node_modules/${input.name}`;
  const lockedPackage = lockfile.packages[path];
  const root = lockfile.packages[''];
  if (!lockedPackage || !root || lockedPackage.link || lockedPackage.version !== input.fromVersion || (lockedPackage.name !== undefined && lockedPackage.name !== input.name)) return { status: 'guidance_only', reason: 'lockfile_unsupported' };
  const section = directSection(manifest, root, input.name);
  if (!section) {
    const hasTransitive = Object.keys(lockfile.packages).some(packagePath => packagePath.endsWith(`/node_modules/${input.name}`));
    return { status: 'guidance_only', reason: hasTransitive ? 'transitive_override_not_supported' : 'package_not_direct' };
  }
  const resolution = selectNpmFixVersion({ name: input.name, fromVersion: input.fromVersion, declaration: section.declaration, advisories: input.advisories, packument: input.packument });
  if ('reason' in resolution) return { status: 'guidance_only', reason: resolution.reason };
  const packument = npmPackumentSchema.parse(input.packument);
  const previousRelease = packument.versions[input.fromVersion];
  const release = packument.versions[resolution.toVersion];
  if (!previousRelease || previousRelease.version !== input.fromVersion || !release || release.version !== resolution.toVersion
    || lockedPackage.resolved !== previousRelease.dist.tarball || lockedPackage.integrity !== previousRelease.dist.integrity
    || !isSha512Integrity(previousRelease.dist.integrity)) return { status: 'guidance_only', reason: 'package_tree_change_required' };
  // An unchanged graph keeps the existing hoisted and nested resolutions intact.
  const metadataKeys = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc', 'bin', 'license', 'hasInstallScript', 'bundleDependencies', 'bundledDependencies'] as const;
  if (metadataKeys.some(key => !equalRecord(previousRelease[key], release[key]) || !equalRecord(lockedPackage[key], previousRelease[key]))) {
    return { status: 'guidance_only', reason: 'package_tree_change_required' };
  }
  const previousScripts = installScriptsSchema.safeParse(previousRelease.scripts ?? {});
  const nextScripts = installScriptsSchema.safeParse(release.scripts ?? {});
  if (!previousScripts.success || !nextScripts.success || !equalRecord(previousScripts.data, nextScripts.data)
    || Object.keys(nextScripts.data).length > 0 && lockedPackage.hasInstallScript !== true) {
    return { status: 'guidance_only', reason: 'package_tree_change_required' };
  }
  const tarball = new URL(release.dist.tarball);
  if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org' || tarball.username || tarball.password || tarball.search || tarball.hash || !tarball.pathname.endsWith('.tgz')
    || !isSha512Integrity(release.dist.integrity)) return { status: 'guidance_only', reason: 'lockfile_unsupported' };

  const originalManifest = manifest;
  const originalLock = z.record(z.string(), z.unknown()).parse(lockfile);
  let nextManifest = replaceJsonPath(manifestFile.content, [section.section, input.name], resolution.toVersion);
  let nextLock = replaceJsonPath(lockFile.content, ['packages', '', section.section, input.name], resolution.toVersion);
  for (const [key, value] of [['version', resolution.toVersion], ['resolved', tarball.href], ['integrity', release.dist.integrity]] as const) {
    nextLock = nextLock && replaceJsonPath(nextLock, ['packages', path, key], value);
  }
  if (lockfile.lockfileVersion === 2) {
    const oldMirror = legacyDependencySchema.safeParse(lockfile.dependencies?.[input.name]);
    if (!oldMirror.success) return { status: 'guidance_only', reason: 'lockfile_unsupported' };
    if (oldMirror.data.version !== lockedPackage.version || oldMirror.data.resolved !== lockedPackage.resolved
      || oldMirror.data.integrity !== lockedPackage.integrity
      || !equalRecord(oldMirror.data.requires, { ...lockedPackage.dependencies, ...lockedPackage.optionalDependencies })) {
      return { status: 'guidance_only', reason: 'package_tree_change_required' };
    }
    for (const [key, value] of [['version', resolution.toVersion], ['resolved', tarball.href], ['integrity', release.dist.integrity]] as const) {
      nextLock = nextLock && replaceJsonPath(nextLock, ['dependencies', input.name, key], value);
    }
  }
  if (!nextManifest || !nextLock) return { status: 'guidance_only', reason: 'lockfile_unsupported' };
  const nextManifestRaw: unknown = JSON.parse(nextManifest);
  const nextLockRaw: unknown = JSON.parse(nextLock);
  const nextManifestJson = z.record(z.string(), z.unknown()).parse(nextManifestRaw);
  const nextLockJson = z.record(z.string(), z.unknown()).parse(nextLockRaw);
  const nextManifestSection = z.record(z.string(), z.unknown()).safeParse(nextManifestJson[section.section]);
  const nextPackages = z.record(z.string(), z.unknown()).safeParse(nextLockJson.packages);
  const nextRoot = nextPackages.success ? z.record(z.string(), z.unknown()).safeParse(nextPackages.data['']) : null;
  const nextRootSection = nextRoot?.success ? z.record(z.string(), z.unknown()).safeParse(nextRoot.data[section.section]) : null;
  const nextTargetPackage = nextPackages.success ? z.record(z.string(), z.unknown()).safeParse(nextPackages.data[path]) : null;
  if (!nextManifestSection?.success || nextManifestSection.data[input.name] !== resolution.toVersion
    || !nextRootSection?.success || nextRootSection.data[input.name] !== resolution.toVersion
    || !nextTargetPackage?.success || nextTargetPackage.data.version !== resolution.toVersion
    || nextTargetPackage.data.resolved !== tarball.href || nextTargetPackage.data.integrity !== release.dist.integrity) {
    return { status: 'guidance_only', reason: 'lockfile_change_out_of_scope' };
  }
  if (lockfile.lockfileVersion === 2) {
    const nextMirror = z.record(z.string(), z.unknown()).safeParse(nextLockJson.dependencies);
    const nextMirrorPackage = nextMirror.success ? z.record(z.string(), z.unknown()).safeParse(nextMirror.data[input.name]) : null;
    if (!nextMirrorPackage?.success || nextMirrorPackage.data.version !== resolution.toVersion
      || nextMirrorPackage.data.resolved !== tarball.href || nextMirrorPackage.data.integrity !== release.dist.integrity) {
      return { status: 'guidance_only', reason: 'lockfile_change_out_of_scope' };
    }
  }
  const normalizeManifest = (value: Record<string, unknown>) => {
    const clone = structuredClone(value);
    const group = clone[section.section];
    if (typeof group === 'object' && group !== null && !Array.isArray(group)) (group as Record<string, unknown>)[input.name] = section.declaration;
    return clone;
  };
  const normalizeLock = (value: Record<string, unknown>) => {
    const clone = structuredClone(value);
    const packages = clone.packages;
    if (typeof packages === 'object' && packages !== null && !Array.isArray(packages)) {
      const rootEntry = (packages as Record<string, unknown>)[''];
      const targetEntry = (packages as Record<string, unknown>)[path];
      if (typeof rootEntry === 'object' && rootEntry !== null && !Array.isArray(rootEntry)) {
        const direct = (rootEntry as Record<string, unknown>)[section.section];
        if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) (direct as Record<string, unknown>)[input.name] = section.declaration;
      }
      if (typeof targetEntry === 'object' && targetEntry !== null && !Array.isArray(targetEntry)) {
        const entry = targetEntry as Record<string, unknown>;
        const oldEntry = lockfile.packages[path];
        if (oldEntry) for (const key of ['version', 'resolved', 'integrity'] as const) {
          if (Object.hasOwn(oldEntry, key)) entry[key] = oldEntry[key];
          else delete entry[key];
        }
      }
    }
    const mirror = clone.dependencies;
    if (lockfile.lockfileVersion === 2 && typeof mirror === 'object' && mirror !== null && !Array.isArray(mirror)) {
      const target = (mirror as Record<string, unknown>)[input.name];
      if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
        const old = lockfile.dependencies?.[input.name];
        if (typeof old === 'object' && old !== null && !Array.isArray(old)) {
          for (const key of ['version', 'resolved', 'integrity'] as const) {
            if (Object.hasOwn(old, key)) (target as Record<string, unknown>)[key] = (old as Record<string, unknown>)[key];
            else delete (target as Record<string, unknown>)[key];
          }
        }
      }
    }
    return clone;
  };
  if (stableJson(normalizeManifest(nextManifestJson)) !== stableJson(originalManifest)
    || stableJson(normalizeLock(nextLockJson)) !== stableJson(originalLock)) return { status: 'guidance_only', reason: 'lockfile_change_out_of_scope' };
  const files = [{ path: packageJsonPath, content: nextManifest }, { path: packageLockPath, content: nextLock }];
  const patchSha256 = sha256(canonicalJson(files.map(file => ({ path: file.path, before: sha256(file.path === packageJsonPath ? manifestFile.content : lockFile.content), after: sha256(file.content) }))));
  return { status: 'ready', packageName: input.name, fromVersion: input.fromVersion, toVersion: resolution.toVersion, relationship: 'direct', section: section.section, packageJsonPath, packageLockPath, files, lockfileSha256: createHash('sha256').update(nextLock).digest('hex'), patchSha256 };
}

export function parseNpmAdvisoryEvidence(excerpt: string, packageNameExpected?: string): { id: string; packageName: string; version: string; location: string; relationship: 'direct'|'transitive'; sourceDigest: string; advisory: OsvAdvisoryMetadata | null } | undefined {
  try {
    const value: unknown = JSON.parse(excerpt);
    const parsed = z.object({
      schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
      id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      package: z.object({
        name: packageName,
        version: z.string().max(100),
        location: z.string().min(1).max(1000),
        relationship: z.enum(['direct','transitive']),
        purl: z.string().min(1).max(512).optional(),
        sourceFile: z.string().min(1).max(512).optional(),
        dependencies: z.array(z.string().min(1).max(512)).max(100).optional(),
        declaredLicense: z.string().max(200).nullable().optional(),
        integrity: z.string().max(1_024).nullable().optional(),
      }).strict(),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      advisory: z.unknown().optional(),
    }).passthrough().safeParse(value);
    if (!parsed.success || packageNameExpected !== undefined && parsed.data.package.name !== packageNameExpected) return undefined;
    let advisory: OsvAdvisoryMetadata | null = null;
    if (parsed.data.advisory !== undefined && parsed.data.advisory !== null) {
      const metadata = osvAdvisoryMetadataSchema.safeParse(parsed.data.advisory);
      if (!metadata.success || metadata.data.id !== parsed.data.id) return undefined;
      advisory = metadata.data;
    }
    return { id: parsed.data.id, packageName: parsed.data.package.name, version: parsed.data.package.version, location: parsed.data.package.location,
      relationship: parsed.data.package.relationship, sourceDigest: parsed.data.sourceDigest, advisory };
  } catch { return undefined; }
}
