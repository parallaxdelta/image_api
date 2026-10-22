import { App } from 'aws-cdk-lib';
import { ImageApiStack } from '../lib/image-api-stack.js';

const app = new App();

new ImageApiStack(app, 'ImageApi', {
  // Account/region come from the active AWS CLI credentials (`aws configure` / `aws login`).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
