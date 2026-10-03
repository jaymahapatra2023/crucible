/**
 * The Crucible stack: one EC2 host running Docker Compose, RDS Postgres 16, one secret, and
 * the IAM the host needs. Small on purpose — docs/DEPLOYMENT_AWS.md §1 explains why not ECS.
 *
 * Reads as the deployment document does, top to bottom: network, database, secret, host, DNS.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'

export interface CrucibleStackProps extends StackProps {
  /** Public hostname Caddy serves and obtains a certificate for. */
  domain: string
  /** Hosted zone name (e.g. `example.org`) to create the A record in; null creates none. */
  hostedZone: string | null
  /** Sized from `preflight.concurrency × probes.cpus` (4 vCPUs) plus headroom for builds. */
  instanceType: string
  rootVolumeGb: number
  dbInstanceType: string
}

export class CrucibleStack extends Stack {
  constructor(scope: Construct, id: string, props: CrucibleStackProps) {
    super(scope, id, props)
    Tags.of(this).add('app', 'crucible')

    // ── network: two AZs (RDS needs them), public subnets for the host, isolated for the DB,
    //    no NAT gateway — the host has a public address and the database needs no egress.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    const hostSg = new ec2.SecurityGroup(this, 'HostSg', {
      vpc, description: 'Crucible host: HTTPS from anywhere, nothing else inbound', allowAllOutbound: true,
    })
    hostSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP: ACME challenge and redirect')
    hostSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS')
    hostSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), 'HTTP/3')
    // No port 22: administration is SSM Session Manager (the role below).

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc, description: 'Crucible database: reachable only from the host', allowAllOutbound: false,
    })
    dbSg.addIngressRule(hostSg, ec2.Port.tcp(5432), 'from the Crucible host')

    // ── database: everything of record. Backups, PITR, encryption, a final snapshot.
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(props.dbInstanceType),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: 'crucible',
      credentials: rds.Credentials.fromGeneratedSecret('crucible'),
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      preferredBackupWindow: '06:00-07:00',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
      enablePerformanceInsights: true,
    })

    // ── the one secret the host reads at deploy time (deploy/aws/secret.example.json).
    //    Created empty: the values are yours to put in; nothing generated here is a real key.
    const envSecret = new secrets.Secret(this, 'EnvSecret', {
      secretName: 'crucible/env',
      description: 'Crucible .env as a JSON object (see deploy/aws/secret.example.json)',
    })

    // ── host
    const role = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Crucible host: reads its secret, writes logs, reachable by SSM',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    })
    envSecret.grantRead(role)
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams',
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
    }))

    const here = dirname(fileURLToPath(import.meta.url))
    const userData = ec2.UserData.custom(readFileSync(join(here, '..', '..', 'user-data.sh'), 'utf8'))

    const host = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup: hostSg,
      role,
      userData,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        // Clones, scan workspaces and the images submission builds produce. Not the database.
        volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true,
        }),
      }],
    })
    Tags.of(host).add('Name', 'crucible')

    const eip = new ec2.CfnEIP(this, 'Eip', { domain: 'vpc', instanceId: host.instanceId })

    // ── DNS, when the zone is in Route 53. Otherwise: an A record at the address below.
    if (props.hostedZone !== null) {
      const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZone })
      new route53.ARecord(this, 'Site', {
        zone, recordName: props.domain, ttl: Duration.seconds(60),
        target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      })
    }

    new CfnOutput(this, 'PublicIp', { value: eip.attrPublicIp, description: 'Point the domain here' })
    new CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress })
    new CfnOutput(this, 'DbMasterSecretArn', {
      value: db.secret?.secretArn ?? '', description: 'RDS-managed master password; read it to compose DATABASE_URL',
    })
    new CfnOutput(this, 'EnvSecretArn', { value: envSecret.secretArn })
    new CfnOutput(this, 'InstanceId', {
      value: host.instanceId, description: 'Connect with: aws ssm start-session --target <id>',
    })
  }
}
