import { createFileRoute } from '@tanstack/react-router';
import { LandingPage } from '../components/landing';

export const Route = createFileRoute('/variantes/anterior')({
  head: () => ({ meta: [{ title: 'Gotchu · Landing anterior' }, { name: 'robots', content: 'noindex' }] }),
  component: LandingPage,
});
