import * as pulumi from '@pulumi/pulumi';
import { parseInfraConfig } from './src/config.js';
import { createInfrastructure } from './src/infrastructure.js';
import { assertCustomerCodeExecutionDisabled } from './src/vm-execution-gate.js';

const config = new pulumi.Config('gotchu');
const infrastructureConfig = parseInfraConfig({
  awsRegion: config.get('awsRegion') ?? 'us-east-1',
  artifactBucketName: config.require('artifactBucketName'),
  sshPublicKey: config.require('sshPublicKey'),
  sshAdminCidrs: config.getObject<unknown>('sshAdminCidrs'),
  controlInstanceType: config.get('controlInstanceType') ?? 't3.small',
  scannerInstanceType: config.get('scannerInstanceType') ?? 't3.medium',
});

const codeExecutionRequested = config.getBoolean('customerCodeExecutionEnabled') ?? false;
assertCustomerCodeExecutionDisabled(codeExecutionRequested, false);

const resources = createInfrastructure(infrastructureConfig);
export const privateVpcId = resources.vpc.id;
export const controlInstancePublicIpv4 = resources.controlInstance.publicIp;
export const controlInstancePrivateIpv4 = resources.controlInstance.privateIp;
export const scannerInstancePrivateIpv4 = resources.scannerInstance.privateIp;
export const scannerHostHasPublicIpv4 = resources.scannerInstance.publicIp.apply((address) => address.length > 0);
export const artifactBucketName = resources.artifactBucket.bucket;
export const customerCodeExecutionEnabled = false;
