import dns from 'node:dns';
import net from 'node:net';
import { Agent, request } from 'undici';
import { ApiError } from '../errors.js';
import { isPublicAddress } from './ipPolicy.js';

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export interface FetchedSource {
  body: Buffer;
  contentType: string | null;
  finalUrl: string;
}

export type SourceFetcher = (url: string) => Promise<FetchedSource>;

const ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED = 'ERR_BLOCKED_ADDRESS';

/** Static checks on a URL before any network activity. Re-run on every redirect hop. */
export function validateSourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('INVALID_PARAMS', 'url must be an absolute http(s) URL', [{ param: 'url', message: 'not a valid URL' }]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('URL_NOT_ALLOWED', `Scheme "${url.protocol.replace(':', '')}" is not allowed; use http or https`);
  }
  if (url.username || url.password) {
    throw new ApiError('URL_NOT_ALLOWED', 'URLs with embedded credentials are not allowed');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new ApiError('URL_NOT_ALLOWED', `Port ${url.port} is not allowed; only 80 and 443 are fetched`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals never hit DNS lookup, so check them here.
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new ApiError('URL_NOT_ALLOWED', 'URL points to a private or reserved network address');
  }
  return url;
}

/**
 * DNS lookup that refuses non-public addresses. Because it runs at connect
 * time on the address actually dialled, it also defeats DNS rebinding
 * (validate-then-resolve-again races).
 */
const guardedLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: Function) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) {
      return callback(Object.assign(new Error(`${hostname} resolves to non-public address`), { code: BLOCKED }));
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
}) as unknown as typeof dns.lookup;

const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

function causeChainHas(err: unknown, code: string): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === code) return true;
  return false;
}

export function createSafeFetcher(limits: FetchLimits): SourceFetcher {
  return async function fetchSource(rawUrl) {
    const signal = AbortSignal.timeout(limits.timeoutMs); // budget covers all hops + body
    let url = validateSourceUrl(rawUrl);

    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await request(url, {
          method: 'GET',
          dispatcher,
          signal,
          headers: { accept: 'image/*', 'user-agent': 'image-api/0.1 (+https://github.com/parallaxdelta/image_api)' },
        });
      } catch (err) {
        if (causeChainHas(err, BLOCKED)) throw new ApiError('URL_NOT_ALLOWED', 'URL resolves to a private or reserved network address');
        if (signal.aborted) throw new ApiError('SOURCE_TIMEOUT', `Source did not respond within ${limits.timeoutMs}ms`);
        throw new ApiError('SOURCE_UNREACHABLE', `Could not connect to ${url.host}`, undefined, { cause: err });
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        await res.body.dump();
        if (hop >= limits.maxRedirects) throw new ApiError('SOURCE_ERROR', `Too many redirects (max ${limits.maxRedirects})`);
        url = validateSourceUrl(new URL(String(res.headers.location), url).toString());
        continue;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.body.dump();
        throw new ApiError('SOURCE_ERROR', `Source responded with HTTP ${res.statusCode}`, { upstreamStatus: res.statusCode });
      }

      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        await res.body.dump();
        throw tooLarge(limits.maxBytes);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > limits.maxBytes) {
            res.body.destroy();
            throw tooLarge(limits.maxBytes);
          }
          chunks.push(chunk);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (signal.aborted) throw new ApiError('SOURCE_TIMEOUT', `Source did not finish within ${limits.timeoutMs}ms`);
        throw new ApiError('SOURCE_UNREACHABLE', 'Connection to source failed mid-download', undefined, { cause: err });
      }

      const ct = res.headers['content-type'];
      return { body: Buffer.concat(chunks), contentType: typeof ct === 'string' ? ct : null, finalUrl: url.toString() };
    }
  };
}

function tooLarge(max: number) {
  return new ApiError('SOURCE_TOO_LARGE', `Source is larger than the ${Math.round(max / 1024 / 1024)}MB limit`);
}
