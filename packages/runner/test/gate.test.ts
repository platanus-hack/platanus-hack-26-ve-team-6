import { describe, expect, it } from 'vitest';
import { checkRunnerGate } from '../src/gate.js';

describe('runner gate', () => {
  it('returns a visible closed reason when KVM cannot be accessed', async () => {
    const result = await checkRunnerGate({ kvmPath: '/path/that/does/not/exist' });
    expect(result.status).toBe('closed');
    if (result.status === 'closed') expect(result.reason).toContain('unavailable or invalid');
  });

  it('does not silently enable an incomplete jailer-backed launch path', async () => {
    const result = await checkRunnerGate();
    expect(result.status).toBe('closed');
    if (result.status === 'closed') {
      expect(result.reason).toMatch(/jailer|KVM|privileged|sandbox|image/i);
    }
  });
});
