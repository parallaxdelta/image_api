import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { Observability } from './observability.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function reservedConcurrency(scope: Construct): number | undefined {
  const raw = scope.node.tryGetContext('reservedConcurrency');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`reservedConcurrency must be a positive integer, got ${raw}`);
  return n;
}

/**
 * CloudFront (public URL + shared cache)
 *   └─ OAC-signed requests ─▶ Lambda Function URL (IAM auth: CloudFront only)
 *        └─ Lambda running the repo's Dockerfile via the Lambda Web Adapter
 */
export class ImageApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Long enough to cover the review window (reviewers may test any time in the week after submission).
    const retention = logs.RetentionDays.ONE_MONTH;
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.DockerImageFunction(this, 'Fn', {
      code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
        platform: Platform.LINUX_AMD64,
        ignoreMode: IgnoreMode.DOCKER, // honour .dockerignore when hashing/building
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 1536, // sharp is CPU-bound; Lambda CPU scales with memory
      timeout: Duration.seconds(25), // > 8s fetch budget + 10s sharp budget
      // Hard ceiling on concurrency (=> cost/abuse). Opt-in via `-c reservedConcurrency=N`, because
      // new AWS accounts have a total limit of 10 and Lambda refuses any reservation there; on such
      // an account that account-wide limit already acts as the ceiling.
      reservedConcurrentExecutions: reservedConcurrency(scope),
      logGroup,
      environment: {
        LOG_LEVEL: 'info',
        // OAC guarantees requests come through CloudFront, which sets this header itself.
        CLIENT_IP_HEADER: 'CloudFront-Viewer-Address',
      },
    });

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl, {
      readTimeout: Duration.seconds(30),
    });

    // Cache key = full query string. TTLs come from the app's Cache-Control;
    // defaultTtl 0 means anything without one (errors, UI) isn't cached.
    const cachePolicy = new cloudfront.CachePolicy(this, 'ProcessCache', {
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(7),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Forwarded to the origin but not part of the cache key.
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ForwardViewer', {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      // Address: rate-limit key (never logged). Country: logged instead of the IP.
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('CloudFront-Viewer-Address', 'CloudFront-Viewer-Country'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'image-api',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy,
        originRequestPolicy,
        compress: true,
      },
      additionalBehaviors: {
        '/health': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
    });

    const obs = new Observability(this, 'Observability', { fn, appLogs: logGroup, distribution, retention });

    new CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'Dashboard', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${obs.dashboardName}`,
    });
    new CfnOutput(this, 'AppLogGroup', { value: logGroup.logGroupName });
    new CfnOutput(this, 'EdgeLogGroup', { value: obs.edgeLogs.logGroupName });
    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
