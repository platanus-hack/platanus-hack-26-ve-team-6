import { Resolver } from 'node:dns/promises';
import { z } from 'zod';

export function createCustomerDnsVerifier(servers: readonly string[] = []) {
  const configured = z.array(z.string().min(1).max(100)).max(5).parse(servers);
  return {
    async resolveTxt(name: string) {
      // Per-request ownership keeps cancellation from affecting another verification.
      const resolver = new Resolver({ timeout: 2_000, tries: 1 });
      if (configured.length) resolver.setServers(configured);
      try { return await resolver.resolveTxt(name); }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return [];
        throw error;
      } finally { resolver.cancel(); }
    },
  };
}
