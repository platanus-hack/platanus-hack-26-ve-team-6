import { describe, expect, it } from 'vitest';
import { extractOsvAffectedSymbols } from '../src/advisory.js';

describe('OSV affected symbol metadata', () => {
  it('extracts named functions from ecosystem and database specific fields only', () => {
    expect(extractOsvAffectedSymbols({ functions: ['parse', { name: 'Parser.read' }] }, {
      affected: { affected_symbols: ['decode'] }, vulnerability: { source: 'https://example.test/advisory' },
    })).toEqual(['Parser.read', 'decode', 'parse']);
  });
});
