import { LRUCache } from 'lru-cache';
import type { CacheOutcome } from './observability.js';
import type { TransformResult } from './transform.js';

export interface CachedImage extends TransformResult {
  etag: string;
}

/**
 * In-process LRU bounded by total bytes, plus single-flight so N concurrent
 * identical requests do one fetch+transform. Per-instance only — a CDN in
 * front (Cache-Control is set on responses) is the shared layer.
 */
export class ResultCache {
  private readonly lru: LRUCache<string, CachedImage>;
  private readonly inflight = new Map<string, Promise<CachedImage>>();
  hits = 0;
  misses = 0;

  constructor(opts: { maxBytes: number; ttlSeconds: number }) {
    this.lru = new LRUCache({
      maxSize: opts.maxBytes,
      sizeCalculation: (v) => Math.max(1, v.data.length),
      ttl: opts.ttlSeconds * 1000,
    });
  }

  /** `coalesced` = joined an identical request already in flight (no extra work done). */
  async getOrCompute(
    key: string,
    compute: () => Promise<CachedImage>,
  ): Promise<{ value: CachedImage; outcome: CacheOutcome }> {
    const cached = this.lru.get(key);
    if (cached) {
      this.hits++;
      return { value: cached, outcome: 'hit' };
    }
    this.misses++;
    const inflight = this.inflight.get(key);
    if (inflight) return { value: await inflight, outcome: 'coalesced' };

    const pending = compute()
      .then((v) => {
        this.lru.set(key, v);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return { value: await pending, outcome: 'miss' };
  }
}
