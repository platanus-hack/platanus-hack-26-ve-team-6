import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DashboardRouteView } from '../components/dashboard-route-view';

export const Route = createFileRoute('/w/$workspaceId/p/$projectId/informes')({
  validateSearch: z.object({ pestana: z.literal('dependencias').optional() }).strict(),
  component: DashboardRouteView,
});
