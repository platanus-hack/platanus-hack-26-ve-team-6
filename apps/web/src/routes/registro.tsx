import { createFileRoute } from '@tanstack/react-router';
import { CustomerDashboard } from '../components/customer-dashboard';

export const Route = createFileRoute('/registro')({
  component: () => <CustomerDashboard authMode="register" />,
});
