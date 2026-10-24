import { isIP } from 'node:net';
import { z } from 'zod';

const sshAdminCidrSchema = z.string().superRefine((cidr, context) => {
  const [address, prefixText, ...extraParts] = cidr.split('/');
  const prefix = Number(prefixText);
  if (extraParts.length > 0 || address === undefined || prefixText === undefined || address.includes('%')) {
    context.addIssue({ code: 'custom', message: 'Admin SSH CIDRs must be explicit IPv4 network ranges.' });
    return;
  }

  const family = isIP(address);
  if (family !== 4 || !Number.isInteger(prefix) || prefix < 16 || prefix > 32) {
    context.addIssue({ code: 'custom', message: 'SSH CIDRs must be IPv4 and no broader than /16.' });
  }
});

const bucketNameSchema = z.string().min(3).max(63)
  .regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/)
  .refine((value) => !value.includes('..') && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value), 'S3 bucket name is invalid.');

const configSchema = z.object({
  awsRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, 'Provide an AWS region such as us-east-1.'),
  artifactBucketName: bucketNameSchema,
  sshPublicKey: z.string().trim().min(1).refine((value) =>
    /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: .*)?$/.test(value),
  'Provide an OpenSSH RSA or Ed25519 public key, not a private key.'),
  sshAdminCidrs: z.array(sshAdminCidrSchema).min(1).max(32),
  controlInstanceType: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/),
  scannerInstanceType: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/),
});

export type InfraConfig = z.infer<typeof configSchema>;

export function parseInfraConfig(input: unknown): InfraConfig {
  return configSchema.parse(input);
}
