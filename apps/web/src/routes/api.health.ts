import { createFileRoute } from '@tanstack/react-router';
import { json } from '../server/http.js';

export const Route = createFileRoute('/api/health')({ server: { handlers: {
  GET: () => json({ service: 'web', status: 'alive' }),
} } });
