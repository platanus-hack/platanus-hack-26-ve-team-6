import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checksum } from './evidence.js';
import { FILE_TIMEOUT_MS, InspectionUnavailable, withDeadline } from './profile.js';
import { readBoundedFile } from './repository.js';

const advisorySchema = z.object({
  id: z.literal('GHSA-35jh-r3h4-6jhm'),
  modified: z.literal('2025-08-12T21:44:24Z'),
  affected: z.array(z.object({
    package: z.object({ ecosystem: z.string(), name: z.string() }),
    ranges: z.array(z.object({ type: z.string(), events: z.array(z.object({ introduced: z.string().optional(), fixed: z.string().optional(), last_affected: z.string().optional() })) })),
  })),
  database_specific: z.object({ severity: z.literal('HIGH'), github_reviewed: z.literal(true) }),
});

export const advisoryProvenanceSchema = z.object({
  id: z.literal('GHSA-35jh-r3h4-6jhm'), source: z.url(), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  retrievedAt: z.iso.datetime(), sourceModifiedAt: z.iso.datetime(), sha256: z.literal('3060fadb9a686e5041d53fe5c20c7844b2a0a49ce8d7b3d89d70703be02ec4f1'),
  license: z.literal('CC-BY-4.0'), attribution: z.string(), changes: z.string(), freshness: z.string(), primaryFix: z.url(),
}).strict();

export async function loadAdvisory() {
  const [bytes, provenanceBytes] = await withDeadline(() => Promise.all([
    readBoundedFile(fileURLToPath(new URL('../advisories/GHSA-35jh-r3h4-6jhm.json', import.meta.url)), 8_192),
    readBoundedFile(fileURLToPath(new URL('../advisories/provenance.json', import.meta.url)), 4_096),
  ]), FILE_TIMEOUT_MS);
  const provenance = advisoryProvenanceSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(provenanceBytes)));
  if (checksum(bytes) !== provenance.sha256) throw new InspectionUnavailable('Captured advisory checksum mismatch');
  const advisory = advisorySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const lodash = advisory.affected.find((item) => item.package.ecosystem === 'npm' && item.package.name === 'lodash');
  if (!lodash?.ranges.some((range) => range.type === 'ECOSYSTEM'
    && JSON.stringify(range.events) === JSON.stringify([{ introduced: '0' }, { fixed: '4.17.21' }]))) {
    throw new InspectionUnavailable('Captured advisory range no longer matches the implemented profile');
  }
  return { bytes, provenanceBytes, provenance };
}

// Only stable, exact three-component versions are supported. Ranges/tags/prereleases stay unknown.
export function matchesCapturedLodashRange(version: string): boolean | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return undefined;
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return major < 4 || major === 4 && (minor < 17 || minor === 17 && patch < 21);
}
