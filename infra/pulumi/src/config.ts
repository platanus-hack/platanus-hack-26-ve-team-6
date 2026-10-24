import { isIP } from 'node:net';
import { z } from 'zod';

const sshAdminCidrSchema = z.string().superRefine((cidr, context) => {
  const parts = cidr.split('/');
  if (parts.length !== 2) {
    context.addIssue({ code: 'custom', message: 'Admin SSH CIDRs must include an explicit prefix length.' });
    return;
  }

  const address = parts[0];
  const prefixText = parts[1];
  if (address === undefined || prefixText === undefined || address.includes('%')) {
    context.addIssue({ code: 'custom', message: 'Admin SSH CIDR is malformed.' });
    return;
  }

  const family = isIP(address);
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  const minimumPrefix = family === 4 ? 16 : 48;
  if (maxPrefix === 0 || !Number.isInteger(prefix) || prefix < minimumPrefix || prefix > maxPrefix) {
    context.addIssue({ code: 'custom', message: 'SSH CIDR must be valid and no broader than /16 IPv4 or /48 IPv6.' });
  }
});

const configSchema = z.object({
  digitalOceanTokenConfigured: z.literal(true),
  spacesAccessIdConfigured: z.literal(true),
  spacesSecretKeyConfigured: z.literal(true),
  sshPublicKey: z.string().trim().min(1).refine((value) =>
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: .*)?$/.test(value),
  'Provide a supported SSH public key, not a private key.'),
  sshAdminCidrs: z.array(sshAdminCidrSchema).min(1).max(32),
  spacesRegion: z.enum(['nyc3', 'ams3', 'sgp1', 'sfo3', 'fra1', 'tor1', 'blr1', 'syd1']),
  spacesBucketName: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/)
    .refine((value) => !value.includes('..') && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value), 'Spaces bucket name is invalid.'),
  digitalOceanRegion: z.enum(['nyc1', 'nyc2', 'nyc3', 'sfo1', 'sfo2', 'sfo3', 'ams2', 'ams3', 'sgp1', 'lon1', 'fra1', 'tor1', 'blr1', 'syd1']),
  controlDropletSize: z.string().regex(/^[a-z0-9-]{2,32}$/),
  runnerDropletSize: z.string().regex(/^[a-z0-9-]{2,32}$/),
});

export type InfraConfig = z.infer<typeof configSchema>;

export function parseInfraConfig(input: unknown): InfraConfig {
  return configSchema.parse(input);
}
