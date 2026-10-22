import { describe, expect, it } from 'vitest';
import { createSafeFetcher, validateSourceUrl } from '../src/fetch/safeFetch.js';

describe('validateSourceUrl', () => {
  it('accepts plain http(s) URLs', () => {
    expect(validateSourceUrl('https://example.com/a.png').hostname).toBe('example.com');
  });

  it.each([
    ['file:///etc/passwd', 'Scheme'],
    ['ftp://example.com/a.png', 'Scheme'],
    ['https://user:pass@example.com/a.png', 'credentials'],
    ['https://example.com:8080/a.png', 'Port'],
    ['http://127.0.0.1/a.png', 'private'],
    ['http://[::1]/a.png', 'private'],
    ['http://169.254.169.254/latest/meta-data', 'private'],
  ])('rejects %s', (url, msg) => {
    expect(() => validateSourceUrl(url)).toThrow(msg);
  });

  it('rejects garbage as INVALID_PARAMS', () => {
    expect(() => validateSourceUrl('not a url')).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });
});

describe('createSafeFetcher (network)', () => {
  const fetchSource = createSafeFetcher({ timeoutMs: 2000, maxBytes: 1024, maxRedirects: 0 });

  it('refuses hostnames that resolve to loopback (connect-time DNS guard)', async () => {
    await expect(fetchSource('http://localhost/')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
  });
});
