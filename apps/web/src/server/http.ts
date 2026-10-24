export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  // Domain errors may cross package boundaries; expose only a bounded public code/message.
  if (error instanceof Error && error.name === 'BackendError' && 'status' in error && typeof error.status === 'number'
    && error.status >= 400 && error.status < 600 && 'code' in error && typeof error.code === 'string') {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: 'internal_error', message: 'The request could not be completed' } }, 500);
}

export async function readBoundedBody(request: Request, maxBytes = 1_048_576): Promise<Buffer> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new HttpError(413, 'body_too_large', 'Request body exceeds the allowed size');
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'body_too_large', 'Request body exceeds the allowed size');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function requireSameOrigin(request: Request, configuredOrigin: string): void {
  if (request.headers.get('Origin') !== configuredOrigin) {
    throw new HttpError(403, 'origin_rejected', 'This session action requires the configured application origin');
  }
}
