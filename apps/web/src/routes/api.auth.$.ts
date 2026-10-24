import { createFileRoute } from '@tanstack/react-router';
import { getWebRuntime } from '../server/runtime.js';
import { errorResponse } from '../server/http.js';

async function handle({ request }: { request: Request }) {
  try { return await getWebRuntime().handleAuth(request); }
  catch (error) { return errorResponse(error); }
}

export const Route = createFileRoute('/api/auth/$')({ server: { handlers: { GET: handle, POST: handle } } });
