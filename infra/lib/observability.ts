import { ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

// Must match src/observability.ts (EMF namespace + dimension).
const NAMESPACE = 'ImageApi';
const DIMENSIONS = { Service: 'image-api' };

/**
 * CloudFront access-log fields delivered to CloudWatch. Deliberately excludes
 * identifying fields: c-ip, c-port, x-forwarded-for, asn, cs(Cookie).
 */
const EDGE_LOG_FIELDS = [
  'timestamp', 'date', 'time', 'DistributionId', 'x-edge-request-id', 'x-edge-location',
  'cs-method', 'cs-protocol', 'cs-uri-stem', 'cs-uri-query', 'cs(User-Agent)', 'cs(Referer)',
  'sc-status', 'sc-bytes', 'sc-content-type', 'time-taken', 'time-to-first-byte',
  'x-edge-result-type', 'x-edge-response-result-type', 'x-edge-detailed-result-type', 'c-country',
];

export interface ObservabilityProps {
  fn: lambda.IFunction;
  appLogs: logs.ILogGroup;
  distribution: cloudfront.Distribution;
  retention: logs.RetentionDays;
}

export class Observability extends Construct {
  readonly dashboardName: string;
  readonly edgeLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, { fn, appLogs, distribution, retention }: ObservabilityProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // ---------- CloudFront access logs → CloudWatch (includes edge cache hits Lambda never sees) ----------
    this.edgeLogs = new logs.LogGroup(this, 'EdgeLogs', {
      logGroupName: `/aws/vendedlogs/cloudfront/${stack.stackName}-access`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const source = new logs.CfnDeliverySource(this, 'EdgeLogSource', {
      name: `${stack.stackName}-cf-access`,
      logType: 'ACCESS_LOGS',
      resourceArn: distribution.distributionArn,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'EdgeLogDestination', {
      name: `${stack.stackName}-cf-access-cwl`,
      outputFormat: 'json',
      destinationResourceArn: stack.formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: this.edgeLogs.logGroupName,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    });
    const delivery = new logs.CfnDelivery(this, 'EdgeLogDelivery', {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
      recordFields: EDGE_LOG_FIELDS,
    });
    delivery.addResourceDependency(source);
    delivery.addResourceDependency(destination);

    // ---------- Saved Logs Insights queries (CloudWatch → Logs Insights → Saved queries) ----------
    const saved = (name: string, logGroups: logs.ILogGroup[], q: logs.QueryStringProps) =>
      new logs.QueryDefinition(this, name.replace(/\W/g, ''), {
        queryDefinitionName: `image-api/${name}`,
        logGroups,
        queryString: new logs.QueryString(q),
      });

    saved('Every request (edge, incl. cache hits)', [this.edgeLogs], {
      fields: [
        '@timestamp', '`sc-status` as status', '`x-edge-result-type` as edge', '`c-country` as country',
        '`cs-uri-stem` as path', '`cs-uri-query` as query', '`time-taken` as seconds', '`cs(User-Agent)` as agent',
      ],
      filterStatements: ['`cs-uri-stem` != "/health"'],
      sort: '@timestamp desc',
      limit: 1000,
    });
    saved('API requests (app detail)', [appLogs], {
      fields: [
        '@timestamp', 'statusCode', 'errorCode', 'cache', 'durationMs', 'fetchMs', 'transformMs', 'country',
        'query.url', 'query.width', 'query.height', 'query.format', 'query.quality', 'query.crop',
      ],
      filterStatements: ['msg = "request completed"', 'path = "/process"'],
      sort: '@timestamp desc',
      limit: 1000,
    });
    saved('Rejected requests', [appLogs], {
      fields: ['@timestamp', 'statusCode', 'errorCode', 'country', 'url'],
      filterStatements: ['msg = "request completed"', 'statusCode >= 400', 'path != "/health"'],
      sort: '@timestamp desc',
      limit: 1000,
    });

    // ---------- Alarm ----------
    const throttles = new cloudwatch.Alarm(this, 'ThrottleAlarm', {
      alarmName: `${stack.stackName}-lambda-throttles`,
      alarmDescription: 'Lambda hit its concurrency limit: requests were rejected with 429/503 at the platform level.',
      metric: fn.metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------- Dashboard ----------
    const app = (metricName: string, statistic: string, label: string) =>
      new cloudwatch.Metric({ namespace: NAMESPACE, metricName, dimensionsMap: DIMENSIONS, statistic, label, period: Duration.minutes(5) });
    const cf = { period: Duration.minutes(5), region: 'us-east-1' }; // CloudFront metrics live in us-east-1

    this.dashboardName = `${stack.stackName}`;
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: this.dashboardName,
      defaultInterval: Duration.days(7),
    });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 2,
        markdown:
          '## image-api\nEdge = every request CloudFront served (incl. cache hits). App = requests that reached Lambda. ' +
          'Per-request detail: **Logs Insights → Saved queries → image-api/**.',
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Edge requests',
        width: 8,
        left: [distribution.metricRequests({ ...cf, statistic: 'Sum', label: 'requests' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Edge error rate (%)',
        width: 8,
        left: [
          distribution.metric4xxErrorRate({ ...cf, label: '4xx %' }),
          distribution.metric5xxErrorRate({ ...cf, label: '5xx %' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda',
        width: 8,
        left: [
          fn.metricInvocations({ period: Duration.minutes(5), label: 'invocations' }),
          fn.metricThrottles({ period: Duration.minutes(5), label: 'throttles' }),
        ],
        right: [fn.metric('ConcurrentExecutions', { statistic: 'Maximum', period: Duration.minutes(5), label: 'max concurrency' })],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API latency (ms)',
        width: 8,
        left: [app('Latency', 'p50', 'total p50'), app('Latency', 'p95', 'total p95')],
        right: [app('FetchLatency', 'p95', 'fetch p95'), app('TransformLatency', 'p95', 'transform p95')],
      }),
      new cloudwatch.GraphWidget({
        title: 'In-memory cache hit rate',
        width: 8,
        left: [app('CacheHit', 'Average', 'hit rate (0–1)')],
        leftYAxis: { min: 0, max: 1 },
      }),
      new cloudwatch.GraphWidget({
        title: 'API errors / bytes',
        width: 8,
        left: [app('ClientError', 'Sum', '4xx'), app('ServerError', 'Sum', '5xx')],
        right: [app('SourceBytes', 'Sum', 'bytes fetched'), app('OutputBytes', 'Sum', 'bytes served')],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent requests at the edge',
        width: 12,
        height: 8,
        logGroupNames: [this.edgeLogs.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, `sc-status` as status, `x-edge-result-type` as edge, `c-country` as country, `cs-uri-stem` as path, `cs-uri-query` as query',
          'filter `cs-uri-stem` != "/health"',
          'sort @timestamp desc',
          'limit 50',
        ],
      }),
      new cloudwatch.LogQueryWidget({
        title: 'API errors by code',
        width: 6,
        height: 8,
        logGroupNames: [appLogs.logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'filter msg = "request completed" and statusCode >= 400 and path != "/health"',
          'stats count(*) as requests by errorCode',
          'sort requests desc',
        ],
      }),
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', width: 6, height: 8, alarms: [throttles] }),
    );
  }
}
