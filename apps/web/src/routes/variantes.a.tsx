import { createFileRoute } from '@tanstack/react-router';
import { VariantA } from '../variants/a';

export const Route = createFileRoute('/variantes/a')({
  head: () => ({ meta: [{ title: 'Gotchu · Variante A' }, { name: 'robots', content: 'noindex' }] }),
  component: VariantA,
});
