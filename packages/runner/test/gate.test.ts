import { describe, expect, it } from 'vitest';
import { checkRunnerGate } from '../src/gate.js';

describe('runner gate', () => {
  it('returns a visible closed reason when KVM cannot be accessed', async () => {
    const result = await checkRunnerGate({ kvmPath: '/path/that/does/not/exist' });
    expect(result.status).toBe('closed');
    if (result.status === 'closed') expect(result.reason).toContain('unavailable or invalid');
  });

  it('keeps execution closed until the host sandbox self-test passes', async () => {
    const result = await checkRunnerGate();
    expect(result.status).toBe('closed');
    if (result.status === 'closed') expect(result.reason).toMatch(/jailer|KVM|sandbox|image/i);
  });
});
