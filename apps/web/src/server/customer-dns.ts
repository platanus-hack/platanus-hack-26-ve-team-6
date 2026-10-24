import { Resolver } from 'node:dns/promises';

export const customerDnsVerifier = {
  async resolveTxt(name: string) {
    // Per-request ownership keeps cancellation from affecting another verification.
    const resolver = new Resolver({ timeout: 2_000, tries: 1 });
    try { return await resolver.resolveTxt(name); }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return [];
      throw error;
    } finally { resolver.cancel(); }
  },
};
