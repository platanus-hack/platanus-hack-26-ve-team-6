import { z } from 'zod';
import type { ModelSecretStore } from '@gotchu/backend';
import {
  investigationModelProviderForPreset,
  investigationModelEndpointSchema,
  investigationProviderCatalog,
} from '@gotchu/contracts';
import { ModelProviderError, type ModelCompletionRequest, type ModelPort } from './model-port.js';
import { createSubscriptionCliPorts, type SubscriptionCliOptions } from './subscription-cli.js';

export { ModelProviderError, type ModelCompletion, type ModelCompletionRequest, type ModelPort } from './model-port.js';

const MAX_RESPONSE_BYTES = 65_536;
const openAiResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).nullable() }).passthrough() }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();
const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).passthrough(),
}).passthrough();


async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new ModelProviderError('request_failed', response.status); }
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    throw new ModelProviderError('invalid_response');
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new ModelProviderError('invalid_response'); }
  if (!response.body) throw new ModelProviderError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ModelProviderError('invalid_response'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return parsed;
  }
  catch { throw new ModelProviderError('invalid_response'); }
}

function endpointUrl(endpoint: URL, suffix: string): URL {
  const base = new URL(endpoint.href.endsWith('/') ? endpoint.href : `${endpoint.href}/`);
  return new URL(suffix, base);
}

function extractJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  }
  // A malformed generated payload does not invalidate the provider's usage.
  catch { return null; }
}

function endpointMatchesPreset(request: ModelCompletionRequest, preset: typeof investigationProviderCatalog[number]): boolean {
  const endpoint = investigationModelEndpointSchema.safeParse(request.endpoint.href);
  return endpoint.success && (preset.baseUrl === null || endpoint.data === new URL(preset.baseUrl).href);
}

function openAiAdapter(fetchImpl: typeof fetch): ModelPort {
  return {
    async complete(request) {
      const preset = investigationProviderCatalog.find(item => item.id === request.providerPresetId);
      if (!preset || preset.billing !== 'per_token' || preset.adapterKind !== 'openai_compatible' || preset.authHeaderStyle !== 'bearer'
        || request.provider !== investigationModelProviderForPreset(preset) || !endpointMatchesPreset(request, preset)) {
        throw new ModelProviderError('invalid_response');
      }
      let response: Response;
      try {
        response = await fetchImpl(endpointUrl(request.endpoint, 'chat/completions'), {
          method: 'POST', signal: request.signal, redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
          body: JSON.stringify({ model: request.modelId, messages: [
            { role: 'system', content: request.systemInstruction }, { role: 'user', content: request.userContext },
          ], [preset.maxTokensField]: request.maxOutputTokens, stream: false,
          ...(preset.supportsJsonObjectMode && [preset.defaultModelId, ...preset.suggestedModelIds].some(modelId => modelId === request.modelId)
            ? { response_format: { type: 'json_object' } } : {}) }),
        });
      } catch { throw new ModelProviderError(request.signal.aborted ? 'aborted' : 'request_failed'); }
      const payload = openAiResponseSchema.safeParse(await readBoundedJson(response));
      if (!payload.success) throw new ModelProviderError('invalid_response');
      const usage = payload.data.usage;
      const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
      const outputTokens = usage.completion_tokens ?? usage.output_tokens;
      if (inputTokens === undefined || outputTokens === undefined) throw new ModelProviderError('missing_usage');
      const content = payload.data.choices[0]?.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      return { output: extractJson(text), inputTokens, outputTokens };
    },
  };
}

function anthropicAdapter(fetchImpl: typeof fetch): ModelPort {
  return {
    async complete(request) {
      const preset = investigationProviderCatalog.find(item => item.id === request.providerPresetId);
      if (!preset || preset.billing !== 'per_token' || preset.adapterKind !== 'anthropic' || preset.authHeaderStyle !== 'anthropic_messages'
        || request.provider !== investigationModelProviderForPreset(preset) || !endpointMatchesPreset(request, preset)) {
        throw new ModelProviderError('invalid_response');
      }
      if (!request.apiKey) throw new ModelProviderError('request_failed', 401);
      let response: Response;
      try {
        response = await fetchImpl(endpointUrl(request.endpoint, 'messages'), {
          method: 'POST', signal: request.signal, redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: request.modelId, system: request.systemInstruction,
            messages: [{ role: 'user', content: request.userContext }], max_tokens: request.maxOutputTokens }),
        });
      } catch { throw new ModelProviderError(request.signal.aborted ? 'aborted' : 'request_failed'); }
      const payload = anthropicResponseSchema.safeParse(await readBoundedJson(response));
      if (!payload.success) throw new ModelProviderError('invalid_response');
      const text = payload.data.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
      return { output: extractJson(text), inputTokens: payload.data.usage.input_tokens, outputTokens: payload.data.usage.output_tokens };
    },
  };
}

export function createModelPort(options: { fetchImpl?: typeof fetch; cli?: SubscriptionCliOptions } = {}): ModelPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cli = createSubscriptionCliPorts(options.cli);
  return {
    complete(request) {
      const preset = investigationProviderCatalog.find(item => item.id === request.providerPresetId);
      switch (preset?.adapterKind) {
        case 'anthropic': return anthropicAdapter(fetchImpl).complete(request);
        case 'claude_code_cli': return cli.claudeCode.complete(request);
        case 'codex_cli': return cli.codex.complete(request);
        default: return openAiAdapter(fetchImpl).complete(request);
      }
    },
  };
}

export type { ModelSecretStore };
