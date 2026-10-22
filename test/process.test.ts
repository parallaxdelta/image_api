import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { fakeFetcher, makeImage, testApp } from './helpers.js';

const SRC = 'https://img.test/photo.png';

describe('GET /process', () => {
  it('resizes and converts format', async () => {
    const app = await testApp(fakeFetcher({ [SRC]: await makeImage('png', 400, 200) }));
    const res = await app.inject(`/process?url=${encodeURIComponent(SRC)}&width=100&format=webp&quality=70`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 100, 50]);
    expect(res.headers['x-source-width']).toBe('400');
    expect(res.headers['cache-control']).toMatch(/max-age=/);
  });

  it.each([
    ['fit', 100, 100, 100, 50],
    ['fill', 100, 100, 100, 100],
    ['scale', 100, 100, 100, 100],
    ['pad', 100, 100, 100, 100],
  ])('crop=%s %ix%i -> %ix%i', async (crop, w, h, ew, eh) => {
    const app = await testApp(fakeFetcher({ [SRC]: await makeImage('png', 400, 200) }));
    const res = await app.inject(`/process?url=${encodeURIComponent(SRC)}&width=${w}&height=${h}&crop=${crop}`);
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([ew, eh]);
  });

  it('serves repeat requests from cache and honours If-None-Match', async () => {
    const fetcher = fakeFetcher({ [SRC]: await makeImage() });
    const app = await testApp(fetcher);
    const url = `/process?url=${encodeURIComponent(SRC)}&width=50`;
    const first = await app.inject(url);
    const second = await app.inject(url);
    expect([first.headers['x-cache'], second.headers['x-cache']]).toEqual(['MISS', 'HIT']);
    expect(fetcher.calls).toHaveLength(1);
    const notModified = await app.inject({ url, headers: { 'if-none-match': String(first.headers.etag) } });
    expect(notModified.statusCode).toBe(304);
  });

  it('returns a structured 400 for bad params', async () => {
    const app = await testApp(fakeFetcher({}));
    const res = await app.inject('/process?url=https://img.test/a.png&width=abc');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' }, requestId: expect.any(String) });
  });

  it('returns 415 for non-image sources', async () => {
    const app = await testApp(fakeFetcher({ [SRC]: Buffer.from('<html>nope</html>') }));
    const res = await app.inject(`/process?url=${encodeURIComponent(SRC)}`);
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('propagates fetch errors with their status', async () => {
    const app = await testApp(fakeFetcher({ [SRC]: new ApiError('SOURCE_TIMEOUT', 'slow') }));
    const res = await app.inject(`/process?url=${encodeURIComponent(SRC)}`);
    expect(res.statusCode).toBe(504);
  });

  it('rate limits with the standard error shape', async () => {
    const app = await testApp(fakeFetcher({}), { RATE_LIMIT_MAX: '2' });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject('/process')).statusCode);
    expect(codes).toEqual([400, 400, 429]);
  });
});

describe('misc routes', () => {
  it('GET /health', async () => {
    const app = await testApp(fakeFetcher({}));
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('unknown routes use the error shape', async () => {
    const app = await testApp(fakeFetcher({}));
    const res = await app.inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('explorer UI', () => {
  it('is served at / as a static page', async () => {
    const app = await testApp(fakeFetcher({}));
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Image API Explorer');
  });
});
