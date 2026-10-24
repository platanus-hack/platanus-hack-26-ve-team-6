import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from '@gotchu/customer-assessment';

export interface ModelEndpointValidator {
  validate(endpoint: string): Promise<void>;
}

export function createModelEndpointValidator(options: {
  allowSelfHostedEndpoints?: boolean;
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  timeoutMs?: number;
} = {}): ModelEndpointValidator {
  const allowSelfHosted = options.allowSelfHostedEndpoints ?? false;
  const lookup = options.lookup ?? (hostname => systemLookup(hostname, { all: true, verbatim: true }));
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new Error('invalid_model_endpoint_timeout');

  return {
    async validate(endpoint: string) {
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new Error('model_endpoint_invalid'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2_048) {
        throw new Error('model_endpoint_https_required');
      }
      if (allowSelfHosted) return;

      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literalFamily = isIP(hostname);
      let addresses: readonly { address: string; family: number }[];
      if (literalFamily) addresses = [{ address: hostname, family: literalFamily }];
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('model_endpoint_dns_timeout')), timeoutMs);
          });
          addresses = await Promise.race([lookup(hostname), deadline]);
        } catch (error) {
          if (error instanceof Error && error.message === 'model_endpoint_dns_timeout') throw error;
          throw new Error('model_endpoint_dns_unavailable', { cause: error });
        } finally { if (timer) clearTimeout(timer); }
      }
      if (!addresses.length || addresses.length > 32 || addresses.some(address => isIP(address.address) !== address.family || !isPublicAddress(address.address))) {
        throw new Error('model_endpoint_nonpublic');
      }
    },
  };
}
