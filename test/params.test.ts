import { describe, expect, it } from 'vitest';
import { cacheKey, parseProcessParams } from '../src/params.js';

const parse = (q: Record<string, string>) => parseProcessParams(q, 4000);

describe('parseProcessParams', () => {
  it('parses a full request and defaults crop to fit', () => {
    expect(parse({ url: 'https://x.test/a.png', width: '500', height: '300', format: 'JPG', quality: '80' })).toEqual({
      url: 'https://x.test/a.png', width: 500, height: 300, format: 'jpeg', quality: 80, crop: 'fit',
    });
  });

  it.each([
    [{}, 'url is required'],
    [{ url: 'u', width: '0' }, 'width must be at least 1'],
    [{ url: 'u', width: '4001' }, 'width must be at most 4000'],
    [{ url: 'u', width: '12.5' }, 'width must be a whole number'],
    [{ url: 'u', height: '-3' }, 'height must be a whole number'],
    [{ url: 'u', format: 'bmp' }, 'format must be one of'],
    [{ url: 'u', quality: '101' }, 'quality must be at most 100'],
    [{ url: 'u', crop: 'fill' }, 'crop requires width'],
    [{ url: 'u', widht: '10' }, 'Unknown parameter(s): widht'],
  ])('rejects %o', (q, msg) => {
    expect(() => parse(q as Record<string, string>)).toThrow(msg);
  });

  it('produces the same cache key regardless of param order', () => {
    const a = parse({ url: 'u', width: '10', format: 'png' });
    const b = parse({ format: 'png', width: '10', url: 'u' });
    expect(cacheKey(a)).toBe(cacheKey(b));
  });
});
