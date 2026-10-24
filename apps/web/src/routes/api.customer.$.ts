import { createFileRoute } from '@tanstack/react-router';
import { getWebRuntime } from '../server/runtime';
import { errorResponse } from '../server/http';
async function handle({ request }: { request: Request }) {
  try { return await getWebRuntime().handleCustomer(request); }
  catch (error) { return errorResponse(error); }
}
export const Route = createFileRoute('/api/customer/$')({ server: { handlers: { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle } } });
