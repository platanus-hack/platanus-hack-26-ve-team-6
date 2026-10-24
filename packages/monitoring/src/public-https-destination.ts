import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from '@gotchu/customer-assessment';

export type PublicHttpsAddress = { address: string; family: 4 | 6 };
export type PublicHttpsLookup = (hostname: string) => Promise<readonly PublicHttpsAddress[]>;

export function createPublicHttpsDestinationResolver(options: {
  lookup?: PublicHttpsLookup;
  timeoutMs?: number;
  testFixture?: { hostname: string; address: '127.0.0.1' | '::1' };
} = {}) {
  const lookup = options.lookup ?? (async hostname => {
    const entries = await systemLookup(hostname, { all: true, verbatim: true });
    return entries.flatMap(entry => entry.family === 4 || entry.family === 6 ? [{ address: entry.address, family: entry.family }] : []);
  });
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new Error('invalid_webhook_dns_timeout');
  if (options.testFixture && (process.env.NODE_ENV !== 'test' || !options.lookup)) throw new Error('invalid_webhook_test_fixture');

  return {
    async resolve(raw: string): Promise<{ url: URL; addresses: readonly PublicHttpsAddress[] }> {
      let url: URL;
      try { url = new URL(raw); }
      catch { throw new Error('webhook_url_invalid'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2048) throw new Error('webhook_https_required');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literalFamily = isIP(hostname);
      let addresses: readonly PublicHttpsAddress[];
      if (literalFamily === 4 || literalFamily === 6) {
        addresses = [{ address: hostname, family: literalFamily }];
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('webhook_dns_timeout')), timeoutMs);
          });
          addresses = await Promise.race([lookup(hostname), deadline]);
        } catch (error) {
          if (error instanceof Error && error.message === 'webhook_dns_timeout') throw error;
          throw new Error('webhook_dns_unavailable', { cause: error });
        } finally { if (timer) clearTimeout(timer); }
      }
      const fixtureAddress = options.testFixture?.hostname === hostname && addresses.length === 1 && addresses[0]?.address === options.testFixture.address;
      if (addresses.length === 0 || addresses.length > 32 || addresses.some(value => isIP(value.address) !== value.family || (!isPublicAddress(value.address) && !fixtureAddress))) {
        throw new Error('webhook_nonpublic_dns');
      }
      return { url, addresses };
    },
  };
}
