import { createFileRoute } from '@tanstack/react-router';
import { CustomerDashboard } from '../components/customer-dashboard';
import { requireSignedIn } from '../components/dashboard-route-view';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: requireSignedIn,
  head: () => ({ meta: [{ title: 'Espacio de trabajo · Gotchu' }] }),
  component: () => <CustomerDashboard routeEntry />,
});
