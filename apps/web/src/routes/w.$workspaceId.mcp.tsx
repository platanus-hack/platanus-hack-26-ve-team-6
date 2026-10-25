import { createFileRoute } from '@tanstack/react-router';
import { DashboardRouteView } from '../components/dashboard-route-view';

export const Route = createFileRoute('/w/$workspaceId/mcp')({
  component: DashboardRouteView,
});
