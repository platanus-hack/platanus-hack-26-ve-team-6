import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import type { InfraConfig } from './config.js';

export function createInfrastructure(
  config: InfraConfig,
  digitalOceanToken: pulumi.Input<string>,
  spacesAccessId: pulumi.Input<string>,
  spacesSecretKey: pulumi.Input<string>,
) {
  const stackLabel = pulumi.getStack().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
  const controlTagName = `gotchu-${stackLabel}-control`;
  const runnerTagName = `gotchu-${stackLabel}-scanner`;

  const provider = new digitalocean.Provider('digitalocean', {
    token: digitalOceanToken,
    spacesAccessId,
    spacesSecretKey,
    spacesEndpoint: `https://${config.spacesRegion}.digitaloceanspaces.com`,
  });

  const controlTag = new digitalocean.Tag('control-tag', { name: controlTagName }, { provider });
  const runnerTag = new digitalocean.Tag('scanner-tag', { name: runnerTagName }, { provider });
  const operatorSshKey = new digitalocean.SshKey('operator-ssh-key', {
    name: `gotchu-${stackLabel}-operator`,
    publicKey: config.sshPublicKey,
  }, { provider });

  const controlFirewall = new digitalocean.Firewall('control-firewall', {
    name: `gotchu-${stackLabel}-control`,
    tags: [controlTag.name],
    inboundRules: [
      { protocol: 'tcp', portRange: '443', sourceAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'tcp', portRange: '80', sourceAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'tcp', portRange: '22', sourceAddresses: config.sshAdminCidrs },
    ],
    outboundRules: [
      { protocol: 'tcp', portRange: '22', destinationTags: [runnerTag.name] },
      { protocol: 'tcp', portRange: '443', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'tcp', portRange: '53', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'udp', portRange: '53', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'udp', portRange: '123', destinationAddresses: ['0.0.0.0/0', '::/0'] },
    ],
  }, { provider });

  const runnerFirewall = new digitalocean.Firewall('scanner-firewall', {
    name: `gotchu-${stackLabel}-scanner`,
    tags: [runnerTag.name],
    inboundRules: [
      { protocol: 'tcp', portRange: '22', sourceTags: [controlTag.name] },
    ],
    outboundRules: [
      { protocol: 'tcp', portRange: '443', destinationTags: [controlTag.name] },
    ],
  }, { provider });

  const privateVpc = new digitalocean.Vpc('private-vpc', {
    name: `gotchu-${stackLabel}-private`,
    description: 'Private service and runner communication for Gotchu.',
    region: config.digitalOceanRegion,
    ipRange: '10.42.0.0/16',
  }, { provider, protect: true });

  const controlDroplet = new digitalocean.Droplet('control-vps', {
    name: `gotchu-${stackLabel}-control`,
    size: config.controlDropletSize,
    image: 'ubuntu-24-04-x64',
    region: config.digitalOceanRegion,
    vpcUuid: privateVpc.id,
    sshKeys: [operatorSshKey.id],
    tags: [controlTag.name],
    ipv6: true,
    publicNetworking: true,
    monitoring: true,
    backups: false,
  }, { provider, dependsOn: [controlFirewall], protect: true });

  const runnerDroplet = new digitalocean.Droplet('scanner-vps', {
    name: `gotchu-${stackLabel}-scanner`,
    size: config.runnerDropletSize,
    image: 'ubuntu-24-04-x64',
    region: config.digitalOceanRegion,
    vpcUuid: privateVpc.id,
    sshKeys: [operatorSshKey.id],
    tags: [runnerTag.name],
    ipv6: false,
    publicNetworking: false,
    monitoring: true,
    backups: false,
  }, { provider, dependsOn: [runnerFirewall], protect: true });

  const artifactBucket = new digitalocean.SpacesBucket('private-artifact-bucket', {
    name: config.spacesBucketName,
    region: config.spacesRegion,
    acl: 'private',
    forceDestroy: false,
    versioning: { enabled: true },
  }, { provider, protect: true });

  return {
    controlTag,
    runnerTag,
    operatorSshKey,
    controlFirewall,
    runnerFirewall,
    privateVpc,
    controlDroplet,
    runnerDroplet,
    artifactBucket,
  };
}
