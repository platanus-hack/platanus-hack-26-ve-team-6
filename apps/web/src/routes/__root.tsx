import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import '../styles/tokens.css';
import '../styles/landing-ui.css';
import { THEME_SCRIPT } from '../components/theme-switch';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Gotchu' }],
    // Applies the stored theme before first paint on every page so no surface flashes the other ground.
    scripts: [{ children: THEME_SCRIPT }],
  }),
  component: () => <html lang="es" suppressHydrationWarning><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>,
});
