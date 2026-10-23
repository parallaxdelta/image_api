import type { FastifyReply, FastifyRequest } from 'fastify';

export type CacheOutcome = 'hit' | 'miss' | 'coalesced';

/** Facts gathered while handling a request, emitted once in its completion log line. */
export interface RequestObs {
  cache?: CacheOutcome;
  fetchMs?: number;
  transformMs?: number;
  sourceHost?: string;
  sourceFormat?: string;
  sourceBytes?: number;
  outputFormat?: string;
  outputBytes?: number;
  errorCode?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    obs: RequestObs;
  }
}

export const METRICS_NAMESPACE = 'ImageApi';
export const METRICS_SERVICE = 'image-api';

const UNITS = {
  Latency: 'Milliseconds',
  FetchLatency: 'Milliseconds',
  TransformLatency: 'Milliseconds',
  CacheHit: 'Count', // 1/0 per request that reached the cache; Average = hit rate
  ClientError: 'Count',
  ServerError: 'Count',
  SourceBytes: 'Bytes',
  OutputBytes: 'Bytes',
} as const;

export type MetricName = keyof typeof UNITS;
export const METRIC_NAMES = Object.keys(UNITS) as MetricName[];

/**
 * CloudWatch Embedded Metric Format: fields to merge into a JSON log line so
 * CloudWatch turns it into metrics, with no SDK or API calls. Only metrics that
 * have a value are declared. One fixed dimension keeps it to one metric each.
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
export function emf(values: Partial<Record<MetricName, number | undefined>>, timestamp = Date.now()) {
  const present = (Object.entries(values) as [MetricName, number | undefined][]).filter(
    (entry): entry is [MetricName, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['Service']],
          Metrics: present.map(([Name]) => ({ Name, Unit: UNITS[Name] })),
        },
      ],
    },
    Service: METRICS_SERVICE,
    ...Object.fromEntries(present),
  };
}

const ms = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);

/**
 * One structured line per request. Deliberately no client IP: behind
 * CloudFront the country is enough to tell sessions apart.
 */
export function completionRecord(req: FastifyRequest, reply: FastifyReply) {
  const status = reply.statusCode;
  const o = req.obs ?? {};
  const country = req.headers['cloudfront-viewer-country'];
  const record = {
    method: req.method,
    path: req.url.split('?')[0],
    url: req.url,
    statusCode: status,
    durationMs: ms(reply.elapsedTime),
    ...(typeof country === 'string' ? { country } : {}),
    ...o,
    fetchMs: ms(o.fetchMs),
    transformMs: ms(o.transformMs),
  };

  if (req.routeOptions.url !== '/process') return record;

  return {
    ...record,
    query: req.query,
    ...emf({
      Latency: ms(reply.elapsedTime),
      FetchLatency: ms(o.fetchMs),
      TransformLatency: ms(o.transformMs),
      CacheHit: o.cache === undefined ? undefined : o.cache === 'miss' ? 0 : 1,
      ClientError: status >= 400 && status < 500 ? 1 : 0,
      ServerError: status >= 500 ? 1 : 0,
      SourceBytes: o.cache === 'miss' ? o.sourceBytes : undefined,
      OutputBytes: o.outputBytes,
    }),
  };
}
