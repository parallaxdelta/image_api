import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ResultCache } from './cache.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { createSafeFetcher, type SourceFetcher } from './fetch/safeFetch.js';
import { processRoutes } from './routes/process.js';

export interface AppDeps {
  /** Injectable for tests; defaults to the SSRF-guarded fetcher. */
  fetchSource?: SourceFetcher;
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  const cache = new ResultCache({ maxBytes: config.CACHE_MAX_BYTES, ttlSeconds: config.CACHE_TTL_SECONDS });
  const fetchSource =
    deps.fetchSource ??
    createSafeFetcher({ timeoutMs: config.FETCH_TIMEOUT_MS, maxBytes: config.MAX_SOURCE_BYTES, maxRedirects: config.MAX_REDIRECTS });

  // Must be set before routes register: Fastify plugins inherit handlers at registration time.
  app.setNotFoundHandler((req, reply) => {
    const err = new ApiError('NOT_FOUND', `No route for ${req.method} ${req.url.split('?')[0]}`);
    reply.code(err.statusCode).send(err.toBody(req.id));
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) req.log.warn({ code: error.code, msg: error.message }, 'request failed');
      return reply.code(error.statusCode).send(error.toBody(req.id));
    }
    req.log.error(error, 'unhandled error');
    const internal = new ApiError('INTERNAL', 'Something went wrong; include the requestId if you report this');
    return reply.code(500).send(internal.toBody(req.id));
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD'],
    exposedHeaders: [
      'x-request-id', 'x-cache', 'etag',
      'x-source-format', 'x-source-width', 'x-source-height', 'x-source-bytes',
      'x-output-width', 'x-output-height',
      'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after',
    ],
  });

  app.get('/health', async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), cache: { hits: cache.hits, misses: cache.misses } }));

  await app.register(processRoutes, { config, cache, fetchSource });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

  return app;
}
