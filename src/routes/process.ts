import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config.js';
import type { ResultCache } from '../cache.js';
import { ApiError } from '../errors.js';
import type { SourceFetcher } from '../fetch/safeFetch.js';
import { cacheKey, parseProcessParams } from '../params.js';
import { MIME, transformImage } from '../transform.js';

export interface ProcessRouteOptions {
  config: Config;
  cache: ResultCache;
  fetchSource: SourceFetcher;
}

/** Strip the port from "ip:port" / "[v6]:port"-style values such as CloudFront-Viewer-Address. */
export function clientIp(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const lastColon = value.lastIndexOf(':');
  const ip = lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1)) ? value.slice(0, lastColon) : value;
  return ip.replace(/^\[|\]$/g, '') || undefined;
}

export const processRoutes: FastifyPluginAsync<ProcessRouteOptions> = async (app, { config, cache, fetchSource }) => {
  // Scoped to this plugin: rate limiting applies to /process, not /health or the UI.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => clientIp(req.headers[config.CLIENT_IP_HEADER ?? '']) ?? req.ip,
    errorResponseBuilder: (_req, ctx) =>
      new ApiError('RATE_LIMITED', `Rate limit of ${ctx.max} requests per ${ctx.after} exceeded; retry later`),
  });

  app.get('/process', async (req, reply) => {
    const params = parseProcessParams(req.query, config.MAX_OUTPUT_DIMENSION);
    const key = cacheKey(params);

    const { value, hit } = await cache.getOrCompute(key, async () => {
      const source = await fetchSource(params.url);
      const result = await transformImage(source.body, params, { maxInputPixels: config.MAX_INPUT_PIXELS });
      const etag = `"${createHash('sha1').update(result.data).digest('base64url')}"`;
      return { ...result, etag };
    });

    reply
      .header('cache-control', `public, max-age=${config.CACHE_TTL_SECONDS}`)
      .header('etag', value.etag)
      .header('x-cache', hit ? 'HIT' : 'MISS')
      .header('x-source-format', value.source.format)
      .header('x-source-width', value.source.width)
      .header('x-source-height', value.source.height)
      .header('x-source-bytes', value.source.bytes)
      .header('x-output-width', value.output.width)
      .header('x-output-height', value.output.height);

    if (req.headers['if-none-match'] === value.etag) return reply.code(304).send();
    return reply.type(MIME[value.output.format as keyof typeof MIME]).send(value.data);
  });
};
