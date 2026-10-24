import { createFileRoute } from '@tanstack/react-router';
import { CustomerDashboard } from '../components/customer-dashboard';

export const Route = createFileRoute('/dashboard')({
  head: () => ({ meta: [{ title: 'Espacio de trabajo · Gotchu' }] }),
  component: CustomerDashboard,
});
