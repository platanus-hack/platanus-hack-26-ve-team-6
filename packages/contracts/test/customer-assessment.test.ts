import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_MAX_SOURCE_FILES, CUSTOMER_MAX_SOURCE_FILE_BYTES, customerOriginSchema, customerPublicImageReferenceSchema, customerSourceSnapshotSchema, customerQueueSchema, customerRunInputSchema, customerAssessmentIntentSchema, customerAssessmentReportSchema, customerEnrollTargetSchema } from '../src/index.js';

const snapshot = () => ({ revision: 'real-revision', files: [{ path: 'src/index.ts', content: 'export const value = 1;' }] });
describe('customer assessment input boundaries', () => {
  it('requires an explicit supported profile without expanding legacy root consent', () => {
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const enrollment = { ...scope, origin: 'https://acme.com', authorized: true };
    expect(customerEnrollTargetSchema.parse(enrollment)).not.toHaveProperty('scanProfile');
    expect(customerEnrollTargetSchema.parse({ ...enrollment, scanProfile: 'public_surface' }).scanProfile).toBe('public_surface');
    expect(customerEnrollTargetSchema.safeParse({ ...enrollment, scanProfile: 'all_internet' }).success).toBe(false);
  });
  it('normalizes public DNS HTTPS origins and rejects URL ambiguity', () => {
    expect(customerOriginSchema.parse('https://APP.acme.com:443/')).toBe('https://app.acme.com');
    for (const origin of ['http://acme.com', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://user@acme.com', 'https://acme.com:444', 'https://acme.com/a', 'https://acme.com/../', 'https://acme.com?', 'https://acme.com#', 'https://acme.com.', 'https://localhost', 'https://app.local', 'https://a_b.acme.com', 'https://acme.com\\@127.0.0.1']) expect(customerOriginSchema.safeParse(origin).success, origin).toBe(false);
  });
  it('rejects traversal, secret/dependency directories, unsupported files and link metadata', () => {
    for (const path of ['/a.ts', '../a.ts', 'a/../b.ts', 'a//b.ts', './a.ts', 'a\\b.ts', 'C:/a.ts', '.git/a.json', 'a/node_modules/p.json', '.env', '.env.json', 'a/.ENV.local.json', 'a.sh', 'a\0.ts']) expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [{ path, content: '' }] }).success, path).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [{ path: 'a.ts', content: '', type: 'symlink', target: '/etc/passwd' }] }).success).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [...snapshot().files, ...snapshot().files] }).success).toBe(false);
  });
  it('counts UTF-8 bytes and bounds source revision, count, individual and aggregate size', () => {
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [{ path: 'a.ts', content: 'é'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES / 2 + 1) }] }).success).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: Array.from({ length: CUSTOMER_MAX_SOURCE_FILES + 1 }, (_, i) => ({ path: `${i}.ts`, content: '' })) }).success).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: Array.from({ length: 5 }, (_, i) => ({ path: `${i}.ts`, content: 'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES) })) }).success).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), revision: 'r'.repeat(201) }).success).toBe(false);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [{ path: 'package-lock.json', content: ' '.repeat(100_000) }] }).success).toBe(true);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: Array.from({ length: CUSTOMER_MAX_SOURCE_FILES }, (_, i) => ({ path: `${i}.ts`, content: '' })) }).success).toBe(true);
  });
  it('requires exactly the requested source/target capabilities', () => {
    const scope = { organizationId: randomUUID(), applicationId: randomUUID(), idempotencyKey: 'key' };
    expect(customerQueueSchema.safeParse({ ...scope, mode: 'external', sourceSnapshotId: null, targetId: randomUUID() }).success).toBe(true);
    expect(customerQueueSchema.safeParse({ ...scope, mode: 'both', sourceSnapshotId: null, targetId: randomUUID() }).success).toBe(false);
    expect(customerQueueSchema.safeParse({ ...scope, mode: 'internal', sourceSnapshotId: randomUUID(), targetId: randomUUID() }).success).toBe(false);
  });
  it('accepts digest-pinned public images and bounded archive inputs only in internal mode', () => {
    const scope = { organizationId: randomUUID(), applicationId: randomUUID(), idempotencyKey: 'image-key' };
    const jobId = randomUUID();
    const imageId = randomUUID();
    const digest = 'a'.repeat(64);
    const reference = `docker.io/library/alpine@sha256:${digest}`;
    const archive = Buffer.from('tiny archive');
    expect(customerPublicImageReferenceSchema.safeParse(reference).success).toBe(true);
    for (const invalid of ['docker.io/library/alpine:latest', 'private.example.com/team/app@sha256:' + digest, 'docker.io/library/alpine@sha256:' + 'A'.repeat(64)]) {
      expect(customerPublicImageReferenceSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    const archiveQueue = { ...scope, mode: 'internal', sourceSnapshotId: null, targetId: null, inputKind: 'container_image', containerImage: { kind: 'archive', imageId } };
    expect(customerQueueSchema.safeParse(archiveQueue).success).toBe(true);
    expect(customerQueueSchema.safeParse({ ...archiveQueue, mode: 'both' }).success).toBe(false);
    const fullInput = { version: 2, organizationId: scope.organizationId, applicationId: scope.applicationId, jobId, applicationName: 'Customer', mode: 'internal', inputKind: 'container_image', source: null, target: null,
      containerImage: { kind: 'archive', id: imageId, digest, size: archive.byteLength, archiveBase64: archive.toString('base64') } };
    expect(customerRunInputSchema.safeParse(fullInput).success).toBe(true);
    expect(customerRunInputSchema.safeParse({ ...fullInput, containerImage: { ...fullInput.containerImage, size: archive.byteLength + 1 } }).success).toBe(false);
    expect(customerAssessmentIntentSchema.safeParse({ ...fullInput, containerImage: { kind: 'archive', id: imageId, digest, size: archive.byteLength } }).success).toBe(true);
    expect(customerSourceSnapshotSchema.safeParse({ ...snapshot(), files: [{ path: 'main.tf', content: 'resource "x" "y" {}' }, { path: 'Dockerfile', content: 'FROM scratch' }, { path: 'app.py', content: 'pass' }, { path: 'main.go', content: 'package main' }, { path: 'App.java', content: 'class App {}' }] }).success).toBe(true);
  });
  it('keeps durable source pointers compact while materialized inputs accept the full source limit', () => {
    const input = { version: 2, organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(), applicationName: 'Customer', mode: 'internal', target: null,
      source: { id: randomUUID(), digest: 'a'.repeat(64), revision: 'r', files: Array.from({ length: 4 }, (_, i) => ({ path: `${i}.ts`, content: 'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES - 1000) })) } };
    expect(customerRunInputSchema.safeParse(input).success).toBe(true);
    const source = { id: input.source.id, digest: input.source.digest, revision: input.source.revision };
    expect(customerAssessmentIntentSchema.safeParse({ ...input, source }).success).toBe(true);
    expect(customerAssessmentIntentSchema.safeParse(input).success).toBe(false);
  });

  it('does not accept a v1 fixture report or mismatched subject', () => {
    const timestamp = new Date().toISOString();
    const report = { version: 2, id: randomUUID(), organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(), applicationName: 'Customer', mode: 'internal', startedAt: timestamp, finishedAt: timestamp,
      internal: { origin: 'internal', status: 'unavailable', startedAt: timestamp, finishedAt: timestamp, snapshotRef: 'sha256:test', tool: { name: 'test', version: '1' }, findings: [], evidence: [], coverage: [], limitations: ['unavailable'] }, external: null, comparison: [], limitations: [], responseMode: 'observation', actionsPerformed: [],
      subject: { sourceSnapshotId: randomUUID(), sourceDigest: 'a'.repeat(64), targetId: null, targetVersion: null, origin: null } };
    expect(customerAssessmentReportSchema.safeParse(report).success).toBe(true);
    expect(customerAssessmentReportSchema.safeParse({ ...report, revision: 'vulnerable' }).success).toBe(false);
    expect(customerAssessmentReportSchema.safeParse({ ...report, subject: { ...report.subject, targetId: randomUUID() } }).success).toBe(false);
    expect(customerAssessmentReportSchema.safeParse({ ...report, internal: { ...report.internal, origin: 'external' } }).success).toBe(false);
    const evidence = Array.from({ length: 200 }, () => ({ id: randomUUID(), origin: 'internal', kind: 'source', locator: 'src/index.ts', collectedAt: timestamp, snapshotRef: 'sha256:test', tool: { name: 'test', version: '1' }, checksum: 'a'.repeat(64), excerpt: 'é'.repeat(4096) }));
    expect(customerAssessmentReportSchema.safeParse({ ...report, internal: { ...report.internal, status: 'completed', evidence } }).success).toBe(false);
    const imageDigest = 'b'.repeat(64);
    const imageReport = { ...report, internal: { ...report.internal, snapshotRef: `container-image:sha256:${imageDigest}` }, subject: {
      sourceSnapshotId: null, sourceDigest: null, targetId: null, targetVersion: null, origin: null,
      containerImageId: randomUUID(), containerImageDigest: imageDigest, containerImageReference: null,
    } };
    expect(customerAssessmentReportSchema.safeParse(imageReport).success).toBe(true);
  });
});
