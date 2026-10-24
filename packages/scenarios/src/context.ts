import { z } from 'zod';
import type { CustomerRunInput } from '@gotchu/contracts';

const MAX_DEPENDENCY_KEYS = 250;
const MAX_CONFIGURATION_PATHS = 100;
const dependencyName = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]{1,214}$/;

export const repositoryContextSchema = z.object({
  dependencyKeys: z.array(z.string().min(1).max(214)).max(MAX_DEPENDENCY_KEYS),
  dependencyKeysTruncated: z.boolean(),
  manifestState: z.enum(['observed', 'partial', 'unknown', 'not_present', 'not_requested']),
  configurationPaths: z.array(z.string().min(1).max(512)).max(MAX_CONFIGURATION_PATHS),
  configurationPathsTruncated: z.boolean(),
  configurationState: z.enum(['identified', 'not_identified', 'not_requested']),
  frameworks: z.array(z.enum(['express', 'fastify', 'koa', 'hono', 'next', 'tanstack-start', 'nestjs', 'nuxt', 'sveltekit'])).max(9),
  infrastructureAreas: z.array(z.enum(['kubernetes', 'helm', 'terraform', 'container', 'reverse_proxy', 'github_actions'])).max(6),
}).strict();

export type RepositoryContext = z.infer<typeof repositoryContextSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyKeys(content: string): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  const keys = new Set<string>();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const group = parsed[section];
    if (!isRecord(group)) continue;
    for (const name of Object.keys(group)) if (dependencyName.test(name)) keys.add(name);
  }
  return [...keys];
}

function isConfigurationPath(path: string): boolean {
  return /(?:^|\/)(?:next|vite|nuxt|svelte|astro|webpack|rollup|postcss|tailwind|eslint|prettier|vitest|jest|playwright|tsconfig)[^/]*\.(?:[cm]?[jt]s|json)$/i.test(path)
    || /(?:^|\/)(?:Dockerfile|docker-compose\.(?:yml|yaml)|compose\.(?:yml|yaml)|Caddyfile|nginx\.conf)$/i.test(path)
    || /(?:^|\/)(?:k8s|kubernetes|helm|charts|terraform|\.github\/workflows)\/.+\.(?:ya?ml|json|tf|hcl)$/i.test(path)
    || /(?:^|\/)Chart\.yaml$/i.test(path)
    || /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/i.test(path);
}

function frameworkNames(keys: ReadonlySet<string>, paths: ReadonlySet<string>): RepositoryContext['frameworks'] {
  const result = new Set<RepositoryContext['frameworks'][number]>();
  if (keys.has('express')) result.add('express');
  if (keys.has('fastify')) result.add('fastify');
  if (keys.has('koa')) result.add('koa');
  if (keys.has('hono')) result.add('hono');
  if (keys.has('next')) result.add('next');
  if (keys.has('@tanstack/react-start') || keys.has('@tanstack/start')) result.add('tanstack-start');
  if (keys.has('@nestjs/core')) result.add('nestjs');
  if (keys.has('nuxt') || keys.has('nitropack')) result.add('nuxt');
  if (keys.has('@sveltejs/kit')) result.add('sveltekit');
  for (const path of paths) {
    if (/^next\.config\./i.test(path)) result.add('next');
    if (/^nuxt\.config\./i.test(path)) result.add('nuxt');
    if (/^svelte\.config\./i.test(path)) result.add('sveltekit');
  }
  return [...result].sort();
}

/** Uses package manifest dependency names and source paths only. No import graph or code is evaluated. */
export function deriveRepositoryContext(input: CustomerRunInput): RepositoryContext {
  const source = input.source;
  if (!source) return repositoryContextSchema.parse({ dependencyKeys: [], dependencyKeysTruncated: false, manifestState: 'not_requested', configurationPaths: [], configurationPathsTruncated: false, configurationState: 'not_requested', frameworks: [], infrastructureAreas: [] });

  const names = new Set<string>();
  const configurations = new Set<string>();
  const areas = new Set<RepositoryContext['infrastructureAreas'][number]>();
  let validManifestCount = 0;
  let invalidManifestCount = 0;
  let dependencyKeysTruncated = false;
  let configurationPathsTruncated = false;
  for (const file of source.files) {
    if (file.path.toLowerCase().split('/').at(-1) === 'package.json') {
      const keys = dependencyKeys(file.content);
      if (keys === undefined) invalidManifestCount += 1;
      else {
        validManifestCount += 1;
        for (const name of keys) {
          if (names.has(name)) continue;
          if (names.size >= MAX_DEPENDENCY_KEYS) { dependencyKeysTruncated = true; break; }
          names.add(name);
        }
      }
    }
    if (!isConfigurationPath(file.path)) continue;
    if (!configurations.has(file.path)) {
      if (configurations.size < MAX_CONFIGURATION_PATHS) configurations.add(file.path);
      else configurationPathsTruncated = true;
    }
    if (/(?:^|\/)(?:k8s|kubernetes)\//i.test(file.path)) areas.add('kubernetes');
    if (/(?:^|\/)(?:helm|charts)\//i.test(file.path) || /(?:^|\/)Chart\.yaml$/i.test(file.path)) areas.add('helm');
    if (/(?:^|\/)terraform\//i.test(file.path) || /\.tf$/i.test(file.path)) areas.add('terraform');
    if (/(?:^|\/)(?:Dockerfile|docker-compose\.(?:yml|yaml)|compose\.(?:yml|yaml))$/i.test(file.path)) areas.add('container');
    if (/(?:^|\/)(?:Caddyfile|nginx\.conf)$/i.test(file.path)) areas.add('reverse_proxy');
    if (/(?:^|\/)\.github\/workflows\//i.test(file.path)) areas.add('github_actions');
  }

  const sortedNames = [...names].sort().slice(0, MAX_DEPENDENCY_KEYS);
  const sortedPaths = [...configurations].sort().slice(0, MAX_CONFIGURATION_PATHS);
  const keySet = new Set(sortedNames);
  const pathSet = new Set(sortedPaths);
  const manifestState = validManifestCount > 0
    ? invalidManifestCount > 0 || dependencyKeysTruncated ? 'partial' : 'observed'
    : invalidManifestCount > 0 ? 'unknown' : 'not_present';
  return repositoryContextSchema.parse({
    dependencyKeys: sortedNames,
    dependencyKeysTruncated,
    manifestState,
    configurationPaths: sortedPaths,
    configurationPathsTruncated,
    configurationState: configurations.size > 0 ? 'identified' : 'not_identified',
    frameworks: frameworkNames(keySet, pathSet),
    infrastructureAreas: [...areas].sort(),
  });
}
