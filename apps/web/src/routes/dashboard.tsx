import { createFileRoute } from '@tanstack/react-router';
import { AssessmentDashboard } from '../components/assessment-dashboard';

export const Route = createFileRoute('/dashboard')({
  head: () => ({ meta: [{ title: 'Evaluaciones · Gotchu' }] }),
  component: AssessmentDashboard,
});
