import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
export interface JsonRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  fetchImplementation?: typeof fetch;
}
export interface JsonHttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export async function requestJson(url: URL, options: JsonRequestOptions = {}): Promise<JsonHttpResponse> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('https_endpoint_required');
  const attempts = Math.max(1, Math.min(3, (options.retries ?? 1) + 1));
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetchImplementation(url, {
        method: options.method ?? 'GET',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('redirect_refused');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < attempts) {
          await delay(retryDelay(response.headers.get('retry-after')), undefined, { signal });
          continue;
        }
        throw new Error('provider_http_failed');
      }
      const body = await readBoundedBody(response, options.maxBytes ?? 1_048_576, signal);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
      if (isPublicError(error) || attempt + 1 >= attempts) throw error;
    }
  }
  throw lastError ?? new Error('provider_unavailable');
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      size += chunk.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('provider_body_limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function retryDelay(header: string | null): number {
  if (!header) return 250;
  const seconds = Number(header);
  const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(delayMs) ? Math.max(0, Math.min(delayMs, 1000)) : 250;
}

function isPublicError(error: unknown): boolean {
  return error instanceof Error && ['redirect_refused', 'provider_body_limit', 'provider_http_failed'].includes(error.message);
}

export function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('provider_invalid_json');
  }
}
