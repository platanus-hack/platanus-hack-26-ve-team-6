import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DashboardRouteView } from '../components/dashboard-route-view';
import { reportTabSlugs } from '../components/customer-report-model';

export const Route = createFileRoute('/w/$workspaceId/p/$projectId/informes')({
  validateSearch: z.object({ pestana: z.enum(reportTabSlugs).optional() }).strict(),
  component: DashboardRouteView,
});
