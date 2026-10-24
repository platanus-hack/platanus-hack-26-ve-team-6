import { describe, expect, it } from 'vitest';
import { createModelPort } from '../src/model-provider.js';
import { redactEvidenceExcerpt } from '../src/service.js';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('replaceable model adapters (fixture provider; not live-model evidence)', () => {
  it('redacts labeled secrets in structured values and quoted JSON before they enter the model request', () => {
    const canary = 'canary-secret-DO_NOT_LEAK-8321';
    const excerpt = redactEvidenceExcerpt({
      source: 'code',
      environment: { api_key: canary, safe: `const config = {"api_key":"${canary}"};` },
    });
    expect(excerpt).not.toContain(canary);
    expect(excerpt).toContain('[REDACTED]');
  });

  it('sends OpenAI-compatible JSON requests and keeps the credential out of the request body', async () => {
    let recordedBody = '';
    let recordedAuthorization = '';
    const canary = 'canary-secret-DO_NOT_LEAK-8321';
    const userContext = redactEvidenceExcerpt({ excerpt: `{"api_key":"${canary}"}` });
    const port = createModelPort({ fetchImpl: async (_input, init) => {
      recordedBody = String(init?.body ?? '');
      recordedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ choices: [{ message: { content: JSON.stringify({ assessment: 'inconclusive', citedEvidenceIds: [uuid] }) } }],
        usage: { prompt_tokens: 25, completion_tokens: 8 } });
    } });
    const result = await port.complete({ provider: 'openai_compatible', endpoint: new URL('http://localhost:11434/v1'), modelId: 'fixture-local',
      apiKey: 'fixture-secret-key', systemInstruction: 'System instruction', userContext, maxOutputTokens: 64, signal: AbortSignal.timeout(1000) });
    expect(recordedAuthorization).toBe('Bearer fixture-secret-key');
    expect(recordedBody).not.toContain('fixture-secret-key');
    expect(recordedBody).not.toContain(canary);
    expect(recordedBody).toContain('fixture-local');
    expect(result).toEqual({ output: { assessment: 'inconclusive', citedEvidenceIds: [uuid] }, inputTokens: 25, outputTokens: 8 });
  });

  it('uses the Anthropic Messages headers and parses reported usage', async () => {
    let recordedBody = '';
    let recordedApiKey = '';
    const port = createModelPort({ fetchImpl: async (_input, init) => {
      recordedBody = String(init?.body ?? '');
      recordedApiKey = new Headers(init?.headers).get('x-api-key') ?? '';
      return Response.json({ content: [{ type: 'text', text: JSON.stringify({ assessment: 'inconclusive' }) }],
        usage: { input_tokens: 18, output_tokens: 5 } });
    } });
    const result = await port.complete({ provider: 'anthropic_messages', endpoint: new URL('https://model.example/v1'), modelId: 'fixture-anthropic',
      apiKey: 'anthropic-fixture-secret', systemInstruction: 'System instruction', userContext: 'Bounded evidence only', maxOutputTokens: 64, signal: AbortSignal.timeout(1000) });
    expect(recordedApiKey).toBe('anthropic-fixture-secret');
    expect(recordedBody).not.toContain('anthropic-fixture-secret');
    expect(result).toEqual({ output: { assessment: 'inconclusive' }, inputTokens: 18, outputTokens: 5 });
  });
});
