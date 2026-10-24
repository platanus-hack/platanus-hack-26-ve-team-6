import { describe, expect, it } from 'vitest';
import { compareAnalyzedToDeployed, originSchema, repositorySubdirectorySchema, securityEventSchema } from '../src/index.js';

const id = '6c8d46c5-420e-4d16-9ca4-9dfb40974755';
describe('application context contracts', () => {
  it('normalizes a safe HTTPS origin and rejects URL paths and credentials', () => {
    expect(originSchema.parse('https://Example.com')).toBe('https://example.com');
    expect(originSchema.safeParse('https://example.com/path').success).toBe(false);
    expect(originSchema.safeParse('https://user@example.com').success).toBe(false);
  });
  it('rejects absolute and traversal repository subdirectories', () => {
    for (const value of ['/app', '../app', 'src/../../app', 'src\\app']) expect(repositorySubdirectorySchema.safeParse(value).success).toBe(false);
    expect(repositorySubdirectorySchema.parse('services/api')).toBe('services/api');
  });
  it('keeps older signed event payloads valid and bounds templated route context', () => {
    const base = { id, type: 'http.request', source: 'application', occurredAt: '2026-10-24T00:00:00.000Z', outcome: 'success' };
    expect(securityEventSchema.safeParse(base).success).toBe(true);
    expect(securityEventSchema.safeParse({ ...base, attributes: { release: 'r42', service: 'api', dependency: 'postgres', route: '/users/{userId}' } }).success).toBe(true);
    expect(securityEventSchema.safeParse({ ...base, attributes: { service: 'https://private.example' } }).success).toBe(false);
    expect(securityEventSchema.safeParse({ ...base, attributes: { route: 'https://example.com/users' } }).success).toBe(false);
    expect(securityEventSchema.safeParse({ ...base, attributes: { route: '/users?id=secret' } }).success).toBe(false);
  });
  it('does not claim a deployment match without verified shared identity', () => {
    const deployment = { commitSha: 'a'.repeat(40), sourceSnapshotDigest: null, state: 'verified' as const };
    expect(compareAnalyzedToDeployed({ commitSha: 'b'.repeat(40) }, deployment)).toBe('differs');
    expect(compareAnalyzedToDeployed({}, deployment)).toBe('unknown');
    expect(compareAnalyzedToDeployed({ commitSha: 'a'.repeat(40) }, { ...deployment, state: 'declared' })).toBe('unknown');
  });
});
