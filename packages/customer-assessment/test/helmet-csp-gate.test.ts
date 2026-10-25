import { describe, expect, it } from 'vitest';
import { assessInternal } from '../src/internal.js';
import { createHelmetCspGate, HELMET_CSP_GATE_VERSION, HELMET_CSP_TYPESCRIPT_VERSION } from '../src/helmet-csp-gate.js';
import { input } from './fixtures.js';

const sourceFor = (content: string, path = 'app.ts') => ({ path, content });
const semgrepOffset = (content: string, marker = 'h({') => {
  const index = content.indexOf(marker);
  return index < 0 ? -1 : Buffer.byteLength(content.slice(0, index), 'utf8');
};

describe('Helmet CSP Semgrep candidate gate', () => {
  it.each([
    ['aliased TypeScript import inside app.use', 'app.ts', "import h from 'helmet';\napp.use(h({contentSecurityPolicy: false}));", 'h({'],
  ])('accepts %s at the call start', (_label, path, content, marker) => {
    const file = sourceFor(content, path);
    const line = content.slice(0, content.indexOf(marker)).split(/\r?\n/).length;
    expect(createHelmetCspGate([file])(path, semgrepOffset(content, marker), line)).toBe(true);
  });

  it('uses UTF-8 byte offsets across Unicode and CRLF, and requires the exact call start', () => {
    const content = "// 😀 before the call\r\nimport h from 'helmet';\r\napp.use(h({contentSecurityPolicy: false}));\r\n";
    const file = sourceFor(content);
    const gate = createHelmetCspGate([file]);
    const byteOffset = semgrepOffset(content, 'h({');
    expect(gate('app.ts', byteOffset, 3, 9)).toBe(true);
    expect(gate('app.ts', content.indexOf('h({'), 3, 9)).toBe(false);
    expect(gate('app.ts', undefined, 3, 9)).toBe(false);
    expect(gate('app.ts', byteOffset + 1, 3, 9)).toBe(false);
    expect(gate('app.ts', byteOffset, 2, 9)).toBe(false);
    expect(gate('app.ts', byteOffset, 3, 10)).toBe(false);
  });

  it.each([
    ['function body', "import h from 'helmet';\nfunction configure() { h({contentSecurityPolicy: false}); }", 'h({'],
    ['arrow body', "import h from 'helmet';\nconst configure = () => h({contentSecurityPolicy: false});", 'h({'],
  ])('ignores candidates inside a %s', (_label, content, marker) => {
    const line = content.slice(0, content.indexOf(marker)).split(/\r?\n/).length;
    expect(createHelmetCspGate([sourceFor(content)])('app.ts', semgrepOffset(content, marker), line)).toBe(false);
  });

  it.each([
    ['enabled', "import h from 'helmet';\nh({contentSecurityPolicy: true});", 'h({'],
    ['nonliteral', "import h from 'helmet';\nh({contentSecurityPolicy: configured});", 'h({'],
    ['duplicate property', "import h from 'helmet';\nh({contentSecurityPolicy: false, contentSecurityPolicy: true});", 'h({'],
    ['spread override', "import h from 'helmet';\nh({contentSecurityPolicy: false, ...defaults});", 'h({'],
  ])('rejects %s options', (_label, content, marker) => {
    const line = content.slice(0, content.indexOf(marker)).split(/\r?\n/).length;
    expect(createHelmetCspGate([sourceFor(content)])('app.ts', semgrepOffset(content, marker), line)).toBe(false);
  });

  it.each([
    ['type-only default import', "import type h from 'helmet';\nh({contentSecurityPolicy: false});"],
    ['same-name block binding', "import h from 'helmet';\nh({contentSecurityPolicy: false});\n{ const h = other; }"],
    ['reassignment', "import h from 'helmet';\nh = replacement;\nh({contentSecurityPolicy: false});"],
  ])('rejects a file with %s', (_label, content) => {
    expect(createHelmetCspGate([sourceFor(content)])('app.ts', semgrepOffset(content), 2)).toBe(false);
  });

  it('normalizes one valid hit for the exact candidate ID', async () => {
    const rule = 'gotchu.javascript.helmet-csp-disabled';
    const content = "import h from 'helmet';\nh({contentSecurityPolicy: false});";
    const request = input([sourceFor(content)]);
    const result = await assessInternal(request, AbortSignal.timeout(5_000), {
      async run(name) {
        if (name !== 'semgrep') throw new Error('unused_fixture_scanner');
        return {
          image: 'semgrep/semgrep@sha256:fixture', version: '1.90.0', profileChecksum: '0'.repeat(64),
          output: { version: '1.90.0', errors: [], paths: { scanned: ['/source/app.ts'] }, results: [
            { check_id: rule, path: '/source/app.ts', start: { line: 2, col: 1, offset: semgrepOffset(content) } },
          ] },
        };
      },
      async readiness() { return { ready: false, tools: [] }; },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ ruleId: rule, correlationKey: 'http:content-security-policy' });
  });

  it('keeps a same-named hit from another scanner on its ordinary key', async () => {
    const request = input([sourceFor('export const value = 1;', 'app.ts')]);
    const result = await assessInternal(request, AbortSignal.timeout(5_000), {
      async run(name) {
        if (name !== 'gitleaks') throw new Error('unused_fixture_scanner');
        return {
          image: 'gitleaks/gitleaks@sha256:fixture', version: '8.21.2', profileChecksum: '0'.repeat(64),
          output: [{ RuleID: 'gotchu.javascript.helmet-csp-disabled', File: '/source/app.ts', StartLine: 1 }],
        };
      },
      async readiness() { return { ready: false, tools: [] }; },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: 'gotchu.javascript.helmet-csp-disabled',
      correlationKey: 'gitleaks:gotchu.javascript.helmet-csp-disabled:app.ts',
    });
  });

  it('preserves other scanner findings and leaves unsupported candidates uncorrelated', async () => {
    const content = "import h from 'helmet';\nh({contentSecurityPolicy: false});";
    const request = input([sourceFor(content)]);
    const result = await assessInternal(request, AbortSignal.timeout(5_000), {
      async run(name) {
        if (name !== 'semgrep') throw new Error('unused_fixture_scanner');
        return {
          image: 'semgrep/semgrep@sha256:fixture', version: '1.90.0', profileChecksum: '0'.repeat(64),
          output: {
            version: '1.90.0', errors: [], paths: { scanned: ['/source/app.ts'] }, results: [
              { check_id: 'profile.gotchu.javascript.helmet-csp-disabled', path: '/source/app.ts', start: { line: 2 } },
              { check_id: 'gotchu.javascript.helmet-csp-disabled', path: '/source/app.ts', start: { line: 2, col: 1, offset: semgrepOffset(content) } },
              { check_id: 'profile.gotchu.javascript.helmet-csp-disabled', path: '/source/app.ts', start: { line: 2, col: 1, offset: semgrepOffset(content) } },
              { check_id: 'other.gotchu.javascript.helmet-csp-disabled', path: '/source/app.ts', start: { line: 2 } },
              { check_id: 'gotchu.javascript.eval', path: '/source/app.ts', start: { line: 2 } },
            ],
          },
        };
      },
      async readiness() { return { ready: false, tools: [] }; },
    });
    expect(result.findings.map(item => item.ruleId)).toEqual([
      'other.gotchu.javascript.helmet-csp-disabled',
      'gotchu.javascript.eval',
    ]);
    expect(result.findings.every(item => item.correlationKey !== 'http:content-security-policy')).toBe(true);
    expect(result.coverage.find(item => item.capability === 'semgrep')).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('unique call offset') });
  });

  it('records gate and parser versions in redacted Semgrep provenance', async () => {
    const content = "import h from 'helmet';\nh({contentSecurityPolicy: false});";
    const request = input([sourceFor(content)]);
    const offset = semgrepOffset(content);
    const result = await assessInternal(request, AbortSignal.timeout(5_000), {
      async run(name) {
        if (name !== 'semgrep') throw new Error('unused_fixture_scanner');
        return {
          image: 'semgrep/semgrep@sha256:fixture', version: '1.90.0', profileChecksum: '0'.repeat(64),
          output: { version: '1.90.0', errors: [], paths: { scanned: ['/source/app.ts'] }, results: [
            { check_id: 'gotchu.javascript.helmet-csp-disabled', path: '/source/app.ts', start: { line: 2, col: 1, offset }, extra: { severity: 'WARNING' } },
          ] },
        };
      },
      async readiness() { return { ready: false, tools: [] }; },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      correlationKey: 'http:content-security-policy', severity: 'medium', confidence: 'inferred', exploitability: 'unknown',
    });
    expect(result.findings[0]?.description).toContain('Registration, execution, other CSP mechanisms, deployment, route association, causality, and exploitability remain unknown.');
    const provenance = result.evidence.find(item => item.locator === 'scanner-profile:semgrep');
    expect(provenance?.excerpt).toContain(HELMET_CSP_GATE_VERSION);
    expect(provenance?.excerpt).toContain(HELMET_CSP_TYPESCRIPT_VERSION);
    expect(provenance?.excerpt).toContain('"redacted":true');
  });
});
