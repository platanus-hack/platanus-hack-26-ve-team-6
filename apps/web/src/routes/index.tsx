import { createFileRoute } from '@tanstack/react-router';
import { Landing } from '../landing/landing';
import { THEME_SCRIPT } from '../landing/theme';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Gotchu · Mira de cerca. Decide con pruebas.' },
      { name: 'description', content: 'Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.' },
    ],
    // Applies the stored theme before first paint so the page never flashes the other ground.
    scripts: [{ children: THEME_SCRIPT }],
  }),
  component: Landing,
});
