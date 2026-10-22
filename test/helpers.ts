import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SourceFetcher } from '../src/fetch/safeFetch.js';

export async function makeImage(format: 'png' | 'jpeg' | 'webp' = 'png', width = 400, height = 200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.8 } } })
    .toFormat(format)
    .toBuffer();
}

export function fakeFetcher(map: Record<string, Buffer | Error>): SourceFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const hit = map[url];
    if (!hit) throw new Error(`fakeFetcher: no fixture for ${url}`);
    if (hit instanceof Error) throw hit;
    return { body: hit, contentType: null, finalUrl: url };
  };
  return Object.assign(fn, { calls });
}

export async function testApp(fetchSource: SourceFetcher, env: Record<string, string> = {}) {
  return buildApp(loadConfig({ LOG_LEVEL: 'silent', ...env }), { fetchSource });
}
