import { describe, expect, it } from 'vitest';
import { createModelEndpointValidator } from '../src/investigation-model-endpoint.js';

describe('custom model endpoint validation', () => {
  it.each(['127.0.0.1', '169.254.169.254', '10.1.2.3', '::1'])('rejects a hostname resolving to private or metadata address %s', async address => {
    const validator = createModelEndpointValidator({ lookup: async hostname => [
      { address, family: address.includes(':') ? 6 : 4 },
    ] });
    await expect(validator.validate('https://model.example/v1')).rejects.toThrow('model_endpoint_nonpublic');
  });

  it('rejects non-HTTPS URLs and accepts public DNS answers', async () => {
    const validator = createModelEndpointValidator({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
    await expect(validator.validate('http://model.example/v1')).rejects.toThrow('model_endpoint_https_required');
    await expect(validator.validate('https://model.example/v1')).resolves.toBeUndefined();
  });

  it('allows private DNS only when the operator opts into self-hosted endpoints', async () => {
    const validator = createModelEndpointValidator({ allowSelfHostedEndpoints: true, lookup: async () => {
      throw new Error('DNS lookup should be bypassed only after operator opt-in');
    } });
    await expect(validator.validate('https://model.internal/v1')).resolves.toBeUndefined();
  });
});
