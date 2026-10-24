import { createFileRoute } from '@tanstack/react-router';
import { VariantC } from '../variants/c';

export const Route = createFileRoute('/variantes/c')({
  head: () => ({ meta: [{ title: 'Gotchu · Variante C' }, { name: 'robots', content: 'noindex' }] }),
  component: VariantC,
});
