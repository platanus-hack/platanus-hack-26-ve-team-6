import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { parseInfraConfig } from '../src/config.js';
import { createInfrastructure } from '../src/infrastructure.js';
import { assertCustomerCodeExecutionDisabled } from '../src/vm-execution-gate.js';

const validConfigInput = {
  digitalOceanTokenConfigured: true,
  spacesAccessIdConfigured: true,
  spacesSecretKeyConfigured: true,
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE9ubHktZXhhbXBsZS1rZXktbm90LXJlYWwtcHVibGljLWtleQ gotchu-tests',
  sshAdminCidrs: ['198.51.100.12/32'],
  spacesRegion: 'fra1',
  spacesBucketName: 'gotchu-test-artifacts-001',
  digitalOceanRegion: 'fra1',
  controlDropletSize: 's-1vcpu-2gb',
  runnerDropletSize: 's-2vcpu-4gb',
} as const;

describe('infrastructure configuration', () => {
  it('requires DigitalOcean and Spaces secrets, a public key, and narrow operator SSH CIDRs', () => {
    expect(() => parseInfraConfig(validConfigInput)).not.toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, digitalOceanTokenConfigured: false })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, spacesAccessIdConfigured: false })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, spacesSecretKeyConfigured: false })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['0.0.0.0/0'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['10.0.0.0/8'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['2001:db8::/32'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshPublicKey: 'not-a-public-key' })).toThrow();
  });

  it('keeps customer-code execution disabled until VM-class isolation evidence is reviewed', () => {
    expect(() => assertCustomerCodeExecutionDisabled(false, false)).not.toThrow();
    expect(() => assertCustomerCodeExecutionDisabled(true, false)).toThrow(/VM-class isolation/);
  });
});

describe('Pulumi resource policy', () => {
  it('mocks a private DigitalOcean VPC, two droplets, restricted firewalls, and a private versioned Space', async () => {
    const registered: pulumi.runtime.MockResourceArgs[] = [];
    pulumi.runtime.setMocks({
      newResource: (args) => {
        registered.push(args);
        return { id: `${args.name}-mock-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    }, 'gotchu-infra-tests', 'security-policy', false);

    const resources = createInfrastructure(
      parseInfraConfig(validConfigInput),
      'test-only-token',
      'test-only-spaces-access-id',
      'test-only-spaces-secret-key',
    );
    const resourceIds = pulumi.all([
      resources.privateVpc.id,
      resources.controlDroplet.id,
      resources.runnerDroplet.id,
      resources.artifactBucket.id,
    ]);
    await new Promise<void>((resolve) => {
      resourceIds.apply(() => resolve());
    });

    const controlDroplet = registered.find((resource) => resource.type === 'digitalocean:index/droplet:Droplet' && resource.name === 'control-vps');
    const runnerDroplet = registered.find((resource) => resource.type === 'digitalocean:index/droplet:Droplet' && resource.name === 'scanner-vps');
    const controlFirewall = registered.find((resource) => resource.type === 'digitalocean:index/firewall:Firewall' && resource.name === 'control-firewall');
    const runnerFirewall = registered.find((resource) => resource.type === 'digitalocean:index/firewall:Firewall' && resource.name === 'scanner-firewall');
    const privateVpc = registered.find((resource) => resource.type === 'digitalocean:index/vpc:Vpc');
    const privateBucket = registered.find((resource) => resource.type === 'digitalocean:index/spacesBucket:SpacesBucket');

    expect(controlDroplet?.inputs).toMatchObject({ publicNetworking: true, vpcUuid: 'private-vpc-mock-id' });
    expect(runnerDroplet?.inputs).toMatchObject({ publicNetworking: false, vpcUuid: 'private-vpc-mock-id' });
    expect(controlFirewall?.inputs.inboundRules).toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '22', sourceAddresses: ['198.51.100.12/32'],
    }));
    expect(controlFirewall?.inputs.inboundRules).toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '443', sourceAddresses: ['0.0.0.0/0', '::/0'],
    }));
    expect(JSON.stringify([controlFirewall?.inputs.inboundRules, runnerFirewall?.inputs.inboundRules])).not.toMatch(/5432|6379/);
    expect(controlFirewall?.inputs.inboundRules).not.toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '22', sourceAddresses: ['0.0.0.0/0', '::/0'],
    }));
    expect(controlFirewall?.inputs.outboundRules).toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '22', destinationTags: ['gotchu-security-policy-scanner'],
    }));
    expect(runnerFirewall?.inputs.inboundRules).toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '22', sourceTags: ['gotchu-security-policy-control'],
    }));
    expect(runnerFirewall?.inputs.outboundRules).toContainEqual(expect.objectContaining({
      protocol: 'tcp', portRange: '443', destinationTags: ['gotchu-security-policy-control'],
    }));
    expect(controlDroplet?.inputs.tags).toEqual(['gotchu-security-policy-control']);
    expect(runnerDroplet?.inputs.tags).toEqual(['gotchu-security-policy-scanner']);
    expect(privateVpc?.inputs.ipRange).toBe('10.42.0.0/16');
    expect(privateBucket?.inputs).toMatchObject({
      acl: 'private',
      forceDestroy: false,
      versioning: { enabled: true },
      region: 'fra1',
    });
    expect(JSON.stringify(privateBucket?.inputs)).not.toMatch(/public-read/);
  });
});
