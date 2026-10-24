import { createFileRoute } from '@tanstack/react-router';
import { getWebRuntime } from '../server/runtime.js';
import { errorResponse, json } from '../server/http.js';

export const Route = createFileRoute('/api/ready')({ server: { handlers: {
  GET: async () => {
    try { const result = await getWebRuntime().readiness(); return json({ status: result.ready ? 'ready' : 'degraded', ...result }, result.ready ? 200 : 503); }
    catch (error) { return errorResponse(error); }
  },
} } });
