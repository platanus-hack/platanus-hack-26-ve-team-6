import * as pulumi from '@pulumi/pulumi';
import { parseInfraConfig } from './src/config.js';
import { createInfrastructure } from './src/infrastructure.js';
import { assertCustomerCodeExecutionDisabled } from './src/vm-execution-gate.js';

const config = new pulumi.Config('gotchu');
const digitalOceanToken = config.requireSecret('digitalOceanToken');
const spacesAccessId = config.requireSecret('spacesAccessId');
const spacesSecretKey = config.requireSecret('spacesSecretKey');
const infrastructureConfig = parseInfraConfig({
  digitalOceanTokenConfigured: true,
  spacesAccessIdConfigured: true,
  spacesSecretKeyConfigured: true,
  sshPublicKey: config.get('sshPublicKey'),
  sshAdminCidrs: config.getObject<unknown>('sshAdminCidrs'),
  spacesRegion: config.get('spacesRegion') ?? 'fra1',
  spacesBucketName: config.get('spacesBucketName'),
  digitalOceanRegion: config.get('digitalOceanRegion') ?? 'fra1',
  controlDropletSize: config.get('controlDropletSize') ?? 's-1vcpu-2gb',
  runnerDropletSize: config.get('runnerDropletSize') ?? 's-2vcpu-4gb',
});

const codeExecutionRequested = config.getBoolean('customerCodeExecutionEnabled') ?? false;
assertCustomerCodeExecutionDisabled(codeExecutionRequested, false);

const resources = createInfrastructure(infrastructureConfig, digitalOceanToken, spacesAccessId, spacesSecretKey);
export const privateVpcId = resources.privateVpc.id;
export const controlDropletIpv4 = resources.controlDroplet.ipv4Address;
export const scannerDropletHasPublicIpv4 = resources.runnerDroplet.ipv4Address.apply((address) => address.length > 0);
export const artifactBucketName = resources.artifactBucket.name;
export const customerCodeExecutionEnabled = false;
