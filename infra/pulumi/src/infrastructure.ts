import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { InfraConfig } from './config.js';

const vpcCidr = '10.42.0.0/16';

function instanceTrustPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'ec2.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });
}

function controlStoragePolicy(bucketArn: string): string {
  const objectResources = [
    'artifacts/*',
    'backups/*',
    'scanner-bootstrap/*',
    'scanner-inputs/*',
    'scanner-results/*',
  ].map((prefix) => `${bucketArn}/${prefix}`);

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListApprovedPrefixes',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: bucketArn,
        Condition: {
          StringLike: {
            's3:prefix': [
              'artifacts', 'artifacts/*', 'backups', 'backups/*',
              'scanner-bootstrap', 'scanner-bootstrap/*', 'scanner-inputs', 'scanner-inputs/*',
              'scanner-results', 'scanner-results/*',
            ],
          },
        },
      },
      {
        Sid: 'ReadArtifactsAndRecoveryData',
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: objectResources,
      },
      {
        Sid: 'WriteArtifactsBackupsAndRunnerImages',
        Effect: 'Allow',
        Action: 's3:PutObject',
        Resource: [
          `${bucketArn}/artifacts/*`,
          `${bucketArn}/backups/*`,
          `${bucketArn}/scanner-bootstrap/*`,
          `${bucketArn}/scanner-inputs/*`,
        ],
      },
    ],
  });
}

function scannerStoragePolicy(bucketArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadRunnerImagesAndJobInputs',
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: [
          `${bucketArn}/scanner-bootstrap/*`,
          `${bucketArn}/scanner-inputs/*`,
        ],
      },
      {
        Sid: 'WriteScannerResults',
        Effect: 'Allow',
        Action: 's3:PutObject',
        Resource: `${bucketArn}/scanner-results/*`,
      },
    ],
  });
}

function scannerEndpointPolicy(bucketArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadRunnerImagesAndJobInputs',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: [
          `${bucketArn}/scanner-bootstrap/*`,
          `${bucketArn}/scanner-inputs/*`,
        ],
      },
      {
        Sid: 'WriteScannerResults',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: `${bucketArn}/scanner-results/*`,
      },
    ],
  });
}

export function createInfrastructure(config: InfraConfig) {
  const stackLabel = pulumi.getStack().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
  const tags = { Project: 'gotchu', Stack: stackLabel, ManagedBy: 'pulumi' };
  const provider = new aws.Provider('aws', { region: config.awsRegion, defaultTags: { tags } });

  const vpc = new aws.ec2.Vpc('private-vpc', {
    cidrBlock: vpcCidr,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { ...tags, Name: `gotchu-${stackLabel}-vpc` },
  }, { provider, protect: true });

  const availabilityZone = `${config.awsRegion}a`;
  const publicSubnet = new aws.ec2.Subnet('control-subnet', {
    vpcId: vpc.id,
    cidrBlock: '10.42.0.0/24',
    availabilityZone,
    mapPublicIpOnLaunch: true,
    tags: { ...tags, Name: `gotchu-${stackLabel}-control` },
  }, { provider });
  const scannerSubnet = new aws.ec2.Subnet('scanner-subnet', {
    vpcId: vpc.id,
    cidrBlock: '10.42.1.0/24',
    availabilityZone,
    mapPublicIpOnLaunch: false,
    tags: { ...tags, Name: `gotchu-${stackLabel}-scanner` },
  }, { provider });

  const internetGateway = new aws.ec2.InternetGateway('internet-gateway', {
    vpcId: vpc.id,
    tags: { ...tags, Name: `gotchu-${stackLabel}-internet` },
  }, { provider });
  const publicRouteTable = new aws.ec2.RouteTable('public-routes', {
    vpcId: vpc.id,
    routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: internetGateway.id }],
    tags: { ...tags, Name: `gotchu-${stackLabel}-public` },
  }, { provider });
  new aws.ec2.RouteTableAssociation('control-route-association', {
    routeTableId: publicRouteTable.id,
    subnetId: publicSubnet.id,
  }, { provider });

  const scannerRouteTable = new aws.ec2.RouteTable('scanner-routes', {
    vpcId: vpc.id,
    tags: { ...tags, Name: `gotchu-${stackLabel}-scanner` },
  }, { provider });
  new aws.ec2.RouteTableAssociation('scanner-route-association', {
    routeTableId: scannerRouteTable.id,
    subnetId: scannerSubnet.id,
  }, { provider });

  const artifactBucket = new aws.s3.Bucket('private-artifact-bucket', {
    bucket: config.artifactBucketName,
    forceDestroy: false,
    tags: { ...tags, Name: `gotchu-${stackLabel}-artifacts` },
  }, { provider, protect: true });

  new aws.s3.BucketOwnershipControls('bucket-ownership-controls', {
    bucket: artifactBucket.id,
    rule: { objectOwnership: 'BucketOwnerEnforced' },
  }, { provider });
  new aws.s3.BucketPublicAccessBlock('bucket-public-access-block', {
    bucket: artifactBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  }, { provider });
  new aws.s3.BucketServerSideEncryptionConfiguration('bucket-encryption', {
    bucket: artifactBucket.id,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
  }, { provider });
  new aws.s3.BucketVersioning('bucket-versioning', {
    bucket: artifactBucket.id,
    versioningConfiguration: { status: 'Enabled' },
  }, { provider });
  new aws.s3.BucketPolicy('bucket-policy', {
    bucket: artifactBucket.id,
    policy: artifactBucket.arn.apply((bucketArn) => JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }],
    })),
  }, { provider });

  const s3Endpoint = new aws.ec2.VpcEndpoint('scanner-s3-endpoint', {
    vpcId: vpc.id,
    serviceName: `com.amazonaws.${config.awsRegion}.s3`,
    vpcEndpointType: 'Gateway',
    routeTableIds: [scannerRouteTable.id],
    policy: artifactBucket.arn.apply(scannerEndpointPolicy),
    tags: { ...tags, Name: `gotchu-${stackLabel}-scanner-s3` },
  }, { provider });

  const operatorSshKey = new aws.ec2.KeyPair('operator-ssh-key', {
    keyName: `gotchu-${stackLabel}-operator`,
    publicKey: config.sshPublicKey,
    tags,
  }, { provider });

  const controlSecurityGroup = new aws.ec2.SecurityGroup('control-security-group', {
    name: `gotchu-${stackLabel}-control`,
    description: 'Public web ingress and scoped operator SSH for the control host.',
    vpcId: vpc.id,
    ingress: [
      {
        description: 'HTTP redirect and ACME HTTP challenge ingress',
        protocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ['0.0.0.0/0'],
      },
      {
        description: 'TLS ingress',
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
      },
      ...config.sshAdminCidrs.map((cidr) => ({
        description: 'Operator SSH from configured admin network',
        protocol: 'tcp',
        fromPort: 22,
        toPort: 22,
        cidrBlocks: [cidr],
      })),
    ],
    egress: [
      {
        description: 'HTTPS to public IPv4 destinations',
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
      },
      {
        description: 'VPC DNS lookups',
        protocol: 'udp',
        fromPort: 53,
        toPort: 53,
        cidrBlocks: [vpcCidr],
      },
      {
        description: 'TCP fallback for VPC DNS lookups',
        protocol: 'tcp',
        fromPort: 53,
        toPort: 53,
        cidrBlocks: [vpcCidr],
      },
      {
        description: 'SSH to the private scanner host',
        protocol: 'tcp',
        fromPort: 22,
        toPort: 22,
        cidrBlocks: ['10.42.1.0/24'],
      },
    ],
    tags: { ...tags, Name: `gotchu-${stackLabel}-control` },
  }, { provider });

  const scannerSecurityGroup = new aws.ec2.SecurityGroup('scanner-security-group', {
    name: `gotchu-${stackLabel}-scanner`,
    description: 'Private scanner ingress through the control host and S3-only egress.',
    vpcId: vpc.id,
    ingress: [{
      description: 'Operator access through the control host only',
      protocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      securityGroups: [controlSecurityGroup.id],
    }],
    egress: [{
      description: 'HTTPS to the private S3 gateway endpoint only',
      protocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      prefixListIds: [s3Endpoint.prefixListId],
    }],
    tags: { ...tags, Name: `gotchu-${stackLabel}-scanner` },
  }, { provider });

  const controlRole = new aws.iam.Role('control-instance-role', {
    name: `gotchu-${stackLabel}-control`,
    assumeRolePolicy: instanceTrustPolicy(),
    tags,
  }, { provider });
  const scannerRole = new aws.iam.Role('scanner-instance-role', {
    name: `gotchu-${stackLabel}-scanner`,
    assumeRolePolicy: instanceTrustPolicy(),
    tags,
  }, { provider });
  new aws.iam.RolePolicy('control-storage-policy', {
    role: controlRole.name,
    policy: artifactBucket.arn.apply(controlStoragePolicy),
  }, { provider });
  new aws.iam.RolePolicy('scanner-storage-policy', {
    role: scannerRole.name,
    policy: artifactBucket.arn.apply(scannerStoragePolicy),
  }, { provider });
  const controlInstanceProfile = new aws.iam.InstanceProfile('control-instance-profile', {
    role: controlRole.name,
  }, { provider });
  const scannerInstanceProfile = new aws.iam.InstanceProfile('scanner-instance-profile', {
    role: scannerRole.name,
  }, { provider });

  const ubuntuAmi = aws.ec2.getAmi({
    owners: ['099720109477'],
    mostRecent: true,
    filters: [
      { name: 'name', values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'] },
      { name: 'architecture', values: ['x86_64'] },
      { name: 'virtualization-type', values: ['hvm'] },
    ],
  }, { provider });

  const controlInstance = new aws.ec2.Instance('control-host', {
    ami: ubuntuAmi.then((ami) => ami.id),
    instanceType: config.controlInstanceType,
    subnetId: publicSubnet.id,
    associatePublicIpAddress: true,
    vpcSecurityGroupIds: [controlSecurityGroup.id],
    keyName: operatorSshKey.keyName,
    iamInstanceProfile: controlInstanceProfile.name,
    ebsOptimized: true,
    rootBlockDevice: {
      encrypted: true,
      volumeType: 'gp3',
      volumeSize: 30,
      deleteOnTermination: true,
    },
    metadataOptions: {
      httpEndpoint: 'enabled',
      httpTokens: 'required',
      httpPutResponseHopLimit: 1,
      instanceMetadataTags: 'disabled',
    },
    tags: { ...tags, Name: `gotchu-${stackLabel}-control` },
    volumeTags: { ...tags, Name: `gotchu-${stackLabel}-control-root` },
  }, { provider, protect: true });

  const scannerInstance = new aws.ec2.Instance('scanner-host', {
    ami: ubuntuAmi.then((ami) => ami.id),
    instanceType: config.scannerInstanceType,
    subnetId: scannerSubnet.id,
    associatePublicIpAddress: false,
    vpcSecurityGroupIds: [scannerSecurityGroup.id],
    keyName: operatorSshKey.keyName,
    iamInstanceProfile: scannerInstanceProfile.name,
    ebsOptimized: true,
    rootBlockDevice: {
      encrypted: true,
      volumeType: 'gp3',
      volumeSize: 30,
      deleteOnTermination: true,
    },
    metadataOptions: {
      httpEndpoint: 'enabled',
      httpTokens: 'required',
      httpPutResponseHopLimit: 1,
      instanceMetadataTags: 'disabled',
    },
    tags: { ...tags, Name: `gotchu-${stackLabel}-scanner` },
    volumeTags: { ...tags, Name: `gotchu-${stackLabel}-scanner-root` },
  }, { provider, protect: true });

  return {
    vpc,
    publicSubnet,
    scannerSubnet,
    publicRouteTable,
    scannerRouteTable,
    controlSecurityGroup,
    scannerSecurityGroup,
    controlInstance,
    scannerInstance,
    artifactBucket,
    s3Endpoint,
    controlRole,
    scannerRole,
  };
}
