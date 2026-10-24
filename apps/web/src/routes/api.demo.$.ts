import { createFileRoute } from '@tanstack/react-router';
import { getWebRuntime } from '../server/runtime.js';
import { errorResponse } from '../server/http.js';

async function handle({ request }: { request: Request }) {
  try { return await getWebRuntime().handleDemo(request); }
  catch (error) { return errorResponse(error); }
}

export const Route = createFileRoute('/api/demo/$')({ server: { handlers: {
  GET: handle,
  POST: handle,
} } });
