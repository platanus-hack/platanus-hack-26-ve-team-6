import { createFileRoute } from '@tanstack/react-router';
import { VariantB } from '../variants/b';

export const Route = createFileRoute('/variantes/b')({
  head: () => ({ meta: [{ title: 'Gotchu · Variante B' }, { name: 'robots', content: 'noindex' }] }),
  component: VariantB,
});
