import { createFileRoute } from '@tanstack/react-router';
// Linked from the route so the server-rendered page is styled before hydration.
import '../components/customer-shell.css';
import '../components/onboarding.css';
import { CustomerDashboard } from '../components/customer-dashboard';
import { requireSignedIn } from '../components/dashboard-route-view';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: requireSignedIn,
  head: () => ({ meta: [{ title: 'Espacio de trabajo · Gotchu' }] }),
  component: () => <CustomerDashboard routeEntry />,
});
