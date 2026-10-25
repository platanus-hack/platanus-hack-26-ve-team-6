import { createFileRoute } from '@tanstack/react-router';
import { getWebRuntime } from '../server/runtime.js';

export const Route = createFileRoute('/install')({ server: { handlers: {
  GET: () => getWebRuntime().handleMcpInstall(),
} } });
