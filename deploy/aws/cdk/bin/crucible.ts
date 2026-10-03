#!/usr/bin/env node
/**
 * Crucible on AWS (docs/DEPLOYMENT_AWS.md).
 *
 *   npx cdk deploy -c domain=crucible.example.org [-c hostedZone=example.org] [-c instanceType=m6i.xlarge]
 *
 * Every knob is a context value with a default the deployment document explains; nothing here
 * needs editing to deploy.
 */
import { App } from 'aws-cdk-lib'
import { CrucibleStack } from '../lib/crucible-stack.js'

const app = new App()

const domain = app.node.tryGetContext('domain') as string | undefined
if (!domain) {
  throw new Error('Pass the public hostname: cdk deploy -c domain=crucible.example.org')
}

new CrucibleStack(app, 'Crucible', {
  domain,
  hostedZone: (app.node.tryGetContext('hostedZone') as string | undefined) ?? null,
  instanceType: (app.node.tryGetContext('instanceType') as string | undefined) ?? 'm6i.xlarge',
  rootVolumeGb: Number(app.node.tryGetContext('rootVolumeGb') ?? 200),
  dbInstanceType: (app.node.tryGetContext('dbInstanceType') as string | undefined) ?? 't4g.medium',
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
  },
})
