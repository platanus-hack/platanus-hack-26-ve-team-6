import { createFileRoute } from '@tanstack/react-router';
import { LandingPage } from '../components/landing';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'Gotchu · Mira de cerca. Decide con pruebas.' },
    { name: 'description', content: 'Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.' },
  ] }),
  component: LandingPage,
});
