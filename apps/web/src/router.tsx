import { createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  // A new client for each SSR request prevents cache reuse across customers.
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    scrollRestoration: true,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
