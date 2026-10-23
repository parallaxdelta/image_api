import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import type { SourceFetcher } from '../src/fetch/safeFetch.js';
import { emf, METRIC_NAMES } from '../src/observability.js';
import { fakeFetcher, makeImage } from './helpers.js';

const SRC = 'https://img.test/photo.png';

async function appWithLogs(fetchSource: SourceFetcher | undefined, env: Record<string, string> = {}) {
  const lines: Record<string, any>[] = [];
  const logStream = new Writable({
    write(chunk, _enc, done) {
      for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l));
      done();
    },
  });
  const app = await buildApp(loadConfig({ LOG_LEVEL: 'info', ...env }), { fetchSource, logStream });
  const completed = () => lines.filter((l) => l.msg === 'request completed');
  const nth = (i: number) => completed()[i]!;
  return { app, lines, completed, nth };
}

/** Every metric declared in _aws must have a numeric value on the line, or CloudWatch drops the line. */
function expectValidEmf(line: Record<string, any>) {
  const [directive] = line._aws.CloudWatchMetrics;
  expect(directive.Namespace).toBe('ImageApi');
  expect(directive.Dimensions).toEqual([['Service']]);
  expect(line.Service).toBe('image-api');
  for (const { Name } of directive.Metrics) expect(typeof line[Name]).toBe('number');
}

describe('emf()', () => {
  it('declares only metrics that have finite values', () => {
    const out = emf({ Latency: 12, FetchLatency: undefined, CacheHit: 0, SourceBytes: Number.NaN }, 1000);
    expect(out._aws.Timestamp).toBe(1000);
    expect(out._aws.CloudWatchMetrics[0]!.Metrics.map((m) => m.Name)).toEqual(['Latency', 'CacheHit']);
    expect(out).toMatchObject({ Latency: 12, CacheHit: 0 });
    expect(out).not.toHaveProperty('FetchLatency');
  });

  it('uses only the known metric names', () => {
    expect(METRIC_NAMES).toHaveLength(8); // keep within CloudWatch's 10 free custom metrics
  });
});

describe('request completed log line', () => {
  it('records a miss with timings, sizes, query and metrics; then a hit without fetch work', async () => {
    const { app, nth } = await appWithLogs(fakeFetcher({ [SRC]: await makeImage('png', 400, 200) }));
    const url = `/process?url=${encodeURIComponent(SRC)}&width=100&format=webp`;
    await app.inject({ url, headers: { 'cloudfront-viewer-country': 'US' } });
    await app.inject(url);

    const miss = nth(0);
    const hit = nth(1);
    expect(miss).toMatchObject({
      method: 'GET', path: '/process', url, statusCode: 200, country: 'US',
      cache: 'miss', sourceHost: 'img.test', sourceFormat: 'png', outputFormat: 'webp',
      query: { url: SRC, width: '100', format: 'webp' },
      CacheHit: 0, ClientError: 0, ServerError: 0,
    });
    expect(miss.fetchMs).toEqual(expect.any(Number));
    expect(miss.transformMs).toEqual(expect.any(Number));
    expect(miss.SourceBytes).toBe(miss.sourceBytes);
    expect(miss.OutputBytes).toBeGreaterThan(0);
    expectValidEmf(miss);

    expect(hit).toMatchObject({ cache: 'hit', CacheHit: 1, statusCode: 200 });
    expect(hit).not.toHaveProperty('fetchMs');
    expect(hit).not.toHaveProperty('FetchLatency');
    expect(hit).not.toHaveProperty('SourceBytes'); // nothing downloaded on a hit
    expectValidEmf(hit);
  });

  it('records the error code and counts client vs server errors', async () => {
    const { app, nth } = await appWithLogs(fakeFetcher({ [SRC]: new ApiError('SOURCE_UNREACHABLE', 'down') }));
    await app.inject('/process?url=https://img.test/a.png&widht=3');
    await app.inject(`/process?url=${encodeURIComponent(SRC)}`);

    const invalid = nth(0);
    const upstream = nth(1);
    expect(invalid).toMatchObject({ statusCode: 400, errorCode: 'INVALID_PARAMS', ClientError: 1, ServerError: 0 });
    expect(invalid).not.toHaveProperty('CacheHit'); // never reached the cache
    expect(upstream).toMatchObject({ statusCode: 502, errorCode: 'SOURCE_UNREACHABLE', ClientError: 0, ServerError: 1, cache: 'miss' });
    expectValidEmf(invalid);
    expectValidEmf(upstream);
  });

  it('logs rate-limited and not-found requests too', async () => {
    const { app, completed } = await appWithLogs(fakeFetcher({}), { RATE_LIMIT_MAX: '1' });
    await app.inject('/process');
    await app.inject('/process');
    await app.inject('/nope');
    expect(completed().map((l) => [l.statusCode, l.errorCode])).toEqual([
      [400, 'INVALID_PARAMS'],
      [429, 'RATE_LIMITED'],
      [404, 'NOT_FOUND'],
    ]);
  });

  it('emits one line per request, with no client IP, and no metrics for non-API routes', async () => {
    const { app, lines, nth } = await appWithLogs(fakeFetcher({}));
    await app.inject({ url: '/health', remoteAddress: '203.0.113.9' });
    expect(lines.filter((l) => l.msg === 'incoming request')).toHaveLength(0);
    const health = nth(0);
    expect(health).toMatchObject({ path: '/health', statusCode: 200 });
    expect(health).not.toHaveProperty('_aws');
    expect(JSON.stringify(lines)).not.toContain('203.0.113.9');
  });

  it('logs malformed input as a client error (real URL checks, no network)', async () => {
    const { app, nth } = await appWithLogs(undefined); // default SSRF-guarded fetcher
    const res = await app.inject('/process?url=%E0%A4%A');
    expect(res.statusCode).toBe(400);
    expect(nth(0)).toMatchObject({ statusCode: 400, errorCode: 'INVALID_PARAMS', ClientError: 1 });
  });
});
