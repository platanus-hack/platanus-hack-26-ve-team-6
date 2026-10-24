import { createFileRoute } from '@tanstack/react-router';
import { LandingPage } from '../components/landing';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'Gotchu · Tu código y tu web, bajo la misma lupa.' },
    { name: 'description', content: 'Sube tu código o conecta tu dominio. Gotchu te dice qué encontró, cómo lo sabe y qué le faltó por revisar.' },
  ] }),
  component: LandingPage,
});
