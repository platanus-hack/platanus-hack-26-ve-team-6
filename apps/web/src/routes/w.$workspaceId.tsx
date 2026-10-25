import { createFileRoute } from '@tanstack/react-router';
// Linked from the route so the server-rendered page is styled before hydration.
import '../components/customer-shell.css';
import '../components/onboarding.css';
import { CustomerDashboard } from '../components/customer-dashboard';
import { requireSignedIn, validateWorkspaceParams } from '../components/dashboard-route-view';

export const Route = createFileRoute('/w/$workspaceId')({
  beforeLoad: async ({ params }) => { validateWorkspaceParams(params); await requireSignedIn(); },
  component: () => { const { workspaceId } = Route.useParams(); return <CustomerDashboard routeOrganizationId={workspaceId} />; },
});
