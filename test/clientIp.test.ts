import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/routes/process.js';

describe('clientIp', () => {
  it.each([
    ['203.0.113.7:51000', '203.0.113.7'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['2001:db8::1:443', '2001:db8::1'],
    ['203.0.113.7', '203.0.113.7'],
    [['198.51.100.2:1'], '198.51.100.2'],
    [undefined, undefined],
    ['', undefined],
  ] as const)('%o -> %o', (input, expected) => {
    expect(clientIp(input as string | string[] | undefined)).toBe(expected);
  });
});
