import { Outlet, createFileRoute } from '@tanstack/react-router';
import { requireSignedIn, validateProjectParams } from '../components/dashboard-route-view';

export const Route = createFileRoute('/w/$workspaceId/p/$projectId')({
  beforeLoad: async ({ params }) => { validateProjectParams(params); await requireSignedIn(); },
  component: () => <Outlet />,
});
