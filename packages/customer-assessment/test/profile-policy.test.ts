import { describe, expect, it } from 'vitest';
import { profiles } from '../src/index.js';

describe('maintained Semgrep release profile', () => {
  it('pins the validated official v1.182.0 image by digest', () => {
    expect(profiles.semgrep).toEqual({
      image: 'semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af',
      version: '1.182.0',
      config: 'semgrep.yaml',
    });
  });
});
