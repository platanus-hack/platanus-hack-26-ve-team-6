import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { parseInfraConfig } from '../src/config.js';
import { createInfrastructure } from '../src/infrastructure.js';
import { assertCustomerCodeExecutionDisabled } from '../src/vm-execution-gate.js';

const validConfigInput = {
  awsRegion: 'us-east-1',
  artifactBucketName: 'gotchu-test-artifacts-001',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE9ubHktZXhhbXBsZS1rZXktbm90LXJlYWwtcHVibGljLWtleQ gotchu-tests',
  sshAdminCidrs: ['198.51.100.12/32'],
  controlInstanceType: 't3.small',
  scannerInstanceType: 't3.medium',
} as const;

describe('infrastructure configuration', () => {
  it('validates AWS config shape, S3 bucket naming, the public key, and narrow operator SSH CIDRs', () => {
    expect(() => parseInfraConfig(validConfigInput)).not.toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, awsRegion: 'not-a-region' })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, artifactBucketName: 'Bad_Bucket' })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['0.0.0.0/0'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['10.0.0.0/8'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshAdminCidrs: ['2001:db8::/48'] })).toThrow();
    expect(() => parseInfraConfig({ ...validConfigInput, sshPublicKey: 'not-a-public-key' })).toThrow();
  });

  it('keeps customer-code execution disabled until VM-class isolation evidence is reviewed', () => {
    expect(() => assertCustomerCodeExecutionDisabled(false, false)).not.toThrow();
    expect(() => assertCustomerCodeExecutionDisabled(true, false)).toThrow(/VM-class isolation/);
  });
});

describe('AWS Pulumi resource policy', () => {
  it('mocks scoped networking, encrypted hosts, private S3 storage, and prefix-limited instance roles', async () => {
    const registered: pulumi.runtime.MockResourceArgs[] = [];
    pulumi.runtime.setMocks({
      newResource: (args) => {
        registered.push(args);
        const state = { ...args.inputs };
        if (args.type === 'aws:ec2/vpcEndpoint:VpcEndpoint') {
          Object.assign(state, { prefixListId: 'pl-s3-mock' });
        }
        if (args.type === 'aws:s3/bucket:Bucket') {
          Object.assign(state, { arn: `arn:aws:s3:::${args.inputs.bucket}` });
        }
        if (args.type === 'aws:ec2/instance:Instance') {
          Object.assign(state, { publicIp: args.name === 'control-host' ? '203.0.113.10' : '' });
        }
        return { id: `${args.name}-mock-id`, state };
      },
      call: (args) => args.token.endsWith(':getAmi')
        ? { ...args.inputs, id: 'ami-ubuntu-mock' }
        : args.inputs,
    }, 'gotchu-infra-tests', 'aws-security-policy', false);

    const resources = createInfrastructure(parseInfraConfig(validConfigInput));
    await new Promise<void>((resolve) => {
      pulumi.all([
        resources.vpc.id,
        resources.publicSubnet.id,
        resources.scannerSubnet.id,
        resources.controlSecurityGroup.id,
        resources.scannerSecurityGroup.id,
        resources.controlInstance.id,
        resources.scannerInstance.id,
        resources.artifactBucket.arn,
        resources.s3Endpoint.prefixListId,
      ]).apply(() => resolve());
    });

    const resource = (type: string, name: string) =>
      registered.find((entry) => entry.type === type && entry.name === name);
    const controlHost = resource('aws:ec2/instance:Instance', 'control-host');
    const scannerHost = resource('aws:ec2/instance:Instance', 'scanner-host');
    const controlSecurityGroup = resource('aws:ec2/securityGroup:SecurityGroup', 'control-security-group');
    const scannerSecurityGroup = resource('aws:ec2/securityGroup:SecurityGroup', 'scanner-security-group');
    const privateSubnet = resource('aws:ec2/subnet:Subnet', 'scanner-subnet');
    const endpoint = resource('aws:ec2/vpcEndpoint:VpcEndpoint', 'scanner-s3-endpoint');
    const bucket = resource('aws:s3/bucket:Bucket', 'private-artifact-bucket');
    const bucketPolicy = resource('aws:s3/bucketPolicy:BucketPolicy', 'bucket-policy');
    const publicAccess = resource('aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock', 'bucket-public-access-block');
    const encryption = resource('aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration', 'bucket-encryption');
    const versioning = resource('aws:s3/bucketVersioning:BucketVersioning', 'bucket-versioning');
    const ownership = resource('aws:s3/bucketOwnershipControls:BucketOwnershipControls', 'bucket-ownership-controls');
    const controlPolicyResource = resource('aws:iam/rolePolicy:RolePolicy', 'control-storage-policy');
    const scannerPolicyResource = resource('aws:iam/rolePolicy:RolePolicy', 'scanner-storage-policy');

    expect(controlHost?.inputs).toMatchObject({
      associatePublicIpAddress: true,
      instanceType: 't3.small',
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
      rootBlockDevice: { encrypted: true, volumeType: 'gp3' },
    });
    expect(scannerHost?.inputs).toMatchObject({
      associatePublicIpAddress: false,
      instanceType: 't3.medium',
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
      rootBlockDevice: { encrypted: true, volumeType: 'gp3' },
    });
    expect(privateSubnet?.inputs).toMatchObject({ cidrBlock: '10.42.1.0/24', mapPublicIpOnLaunch: false });

    const controlIngress = controlSecurityGroup?.inputs.ingress as Array<Record<string, unknown>>;
    const controlEgress = controlSecurityGroup?.inputs.egress as Array<Record<string, unknown>>;
    const scannerIngress = scannerSecurityGroup?.inputs.ingress as Array<Record<string, unknown>>;
    const scannerEgress = scannerSecurityGroup?.inputs.egress as Array<Record<string, unknown>>;
    expect(controlIngress).toContainEqual(expect.objectContaining({ fromPort: 443, cidrBlocks: ['0.0.0.0/0'] }));
    expect(controlIngress).toContainEqual(expect.objectContaining({ fromPort: 80, cidrBlocks: ['0.0.0.0/0'] }));
    expect(controlIngress).toContainEqual(expect.objectContaining({ fromPort: 22, cidrBlocks: ['198.51.100.12/32'] }));
    expect(controlIngress).not.toContainEqual(expect.objectContaining({ fromPort: 22, cidrBlocks: ['0.0.0.0/0'] }));
    expect(controlEgress).toContainEqual(expect.objectContaining({ fromPort: 22, cidrBlocks: ['10.42.1.0/24'] }));
    expect(scannerIngress).toContainEqual(expect.objectContaining({ fromPort: 22, securityGroups: ['control-security-group-mock-id'] }));
    expect(scannerEgress).toEqual([expect.objectContaining({ fromPort: 443, prefixListIds: ['pl-s3-mock'] })]);
    expect(JSON.stringify([controlIngress, scannerIngress])).not.toContain('4100');
    expect(endpoint?.inputs).toMatchObject({
      serviceName: 'com.amazonaws.us-east-1.s3',
      vpcEndpointType: 'Gateway',
      routeTableIds: ['scanner-routes-mock-id'],
    });
    const endpointPolicyText = String(endpoint?.inputs.policy);
    expect(endpointPolicyText).toContain('gotchu-test-artifacts-001/scanner-bootstrap/*');
    expect(endpointPolicyText).toContain('gotchu-test-artifacts-001/scanner-results/*');
    expect(endpointPolicyText).not.toMatch(/DeleteObject|s3:ListBucket/);
    expect(registered.some((entry) => entry.type === 'aws:ec2/natGateway:NatGateway')).toBe(false);
    expect(JSON.stringify([controlIngress, controlEgress, scannerIngress, scannerEgress])).not.toMatch(/5432|6379/);

    expect(bucket?.inputs).toMatchObject({ bucket: 'gotchu-test-artifacts-001', forceDestroy: false });
    expect(publicAccess?.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(encryption?.inputs.rules).toContainEqual(expect.objectContaining({
      applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
    }));
    expect(versioning?.inputs.versioningConfiguration).toEqual({ status: 'Enabled' });
    expect(ownership?.inputs.rule).toEqual({ objectOwnership: 'BucketOwnerEnforced' });

    const storedBucketPolicy = JSON.parse(String(bucketPolicy?.inputs.policy)) as {
      Statement: Array<{ Effect: string; Condition?: { Bool?: Record<string, string> } }>;
    };
    expect(storedBucketPolicy.Statement).toContainEqual(expect.objectContaining({
      Effect: 'Deny',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    const scannerPolicy = JSON.parse(String(scannerPolicyResource?.inputs.policy)) as {
      Statement: Array<{ Action: string; Resource: string | string[] }>;
    };
    const scannerPolicyText = JSON.stringify(scannerPolicy);
    expect(scannerPolicyText).toContain('gotchu-test-artifacts-001/scanner-bootstrap/*');
    expect(scannerPolicyText).toContain('gotchu-test-artifacts-001/scanner-inputs/*');
    expect(scannerPolicyText).toContain('gotchu-test-artifacts-001/scanner-results/*');
    expect(scannerPolicyText).not.toContain('s3:ListBucket');
    expect(scannerPolicyText).not.toMatch(/DeleteObject|backups\/\*/);

    const controlPolicy = JSON.parse(String(controlPolicyResource?.inputs.policy)) as {
      Statement: Array<{ Action: string | string[] }>;
    };
    expect(JSON.stringify(controlPolicy)).toContain('s3:PutObject');
    expect(JSON.stringify(controlPolicy)).not.toContain('s3:DeleteObject');
  });
});
