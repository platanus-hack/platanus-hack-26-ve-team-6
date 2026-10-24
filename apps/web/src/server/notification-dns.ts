import { Resolver } from 'node:dns/promises';
import { BackendError } from '@gotchu/backend';
import { createPublicHttpsDestinationResolver, type PublicHttpsAddress } from '@gotchu/monitoring';

export function createNotificationWebhookValidator(servers: readonly string[] = []) {
  const resolverServers = [...servers];
  const destinationResolver = createPublicHttpsDestinationResolver({ lookup: async hostname => {
    const resolver = new Resolver({ timeout: 1_000, tries: 1 });
    if (resolverServers.length > 0) resolver.setServers(resolverServers);
    try {
      const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      const addresses: PublicHttpsAddress[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const address of result.value) addresses.push({ address, family: address.includes(':') ? 6 : 4 });
          continue;
        }
        const error = result.reason;
        const code = error instanceof Error && 'code' in error ? error.code : null;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw error;
      }
      return addresses;
    } finally { resolver.cancel(); }
  } });
  return {
    async validate(url: string) {
      try { await destinationResolver.resolve(url); }
      catch (error) {
        if (error instanceof Error && error.message === 'webhook_nonpublic_dns') {
          throw new BackendError('webhook_address_rejected', 'Webhook destinations must resolve only to public addresses', 400);
        }
        if (error instanceof Error && error.message === 'webhook_https_required') {
          throw new BackendError('webhook_https_required', 'Webhook destinations must use HTTPS without credentials, query, or fragment', 400);
        }
        throw new BackendError('webhook_dns_unavailable', 'Webhook DNS could not be validated within its deadline', 503, { cause: error });
      }
    },
  };
}
