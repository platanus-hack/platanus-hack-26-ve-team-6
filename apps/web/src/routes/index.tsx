import { createFileRoute } from '@tanstack/react-router';
import { LandingPage } from '../components/landing';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'Gotchu · Tu código y tu web, bajo la misma lupa.' },
    { name: 'description', content: 'Revisa código y HTTPS autorizado. Contrasta hallazgos con su evidencia y decide qué revisar con tu equipo.' },
  ] }),
  component: LandingPage,
});
