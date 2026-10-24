import { createFileRoute } from '@tanstack/react-router';
import { authSettings, createAuthService } from '../server/auth.js';
import { errorResponse } from '../server/http.js';

async function handle({ request }: { request: Request }) {
  try { return await createAuthService(authSettings()).handle(request); }
  catch (error) { return errorResponse(error); }
}

export const Route = createFileRoute('/api/auth/$')({ server: { handlers: { GET: handle, POST: handle } } });
