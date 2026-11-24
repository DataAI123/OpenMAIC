import { describe, expect, it } from 'vitest';

import { parseRetryAfterSeconds } from '@/lib/generation/retry-after';

describe('parseRetryAfterSeconds', () => {
  it('parses bounded integer and fractional seconds', () => {
    expect(parseRetryAfterSeconds('12')).toBe(12);
    expect(parseRetryAfterSeconds('2.1')).toBe(3);
    expect(parseRetryAfterSeconds('999999')).toBe(86_400);
  });

  it('parses future HTTP dates and rejects expired or malformed values', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    expect(parseRetryAfterSeconds('Thu, 08 Oct 2026 00:00:08 GMT', now)).toBe(8);
    expect(parseRetryAfterSeconds('Wed, 07 Oct 2026 23:59:59 GMT', now)).toBeUndefined();
    expect(parseRetryAfterSeconds('not a date', now)).toBeUndefined();
    expect(parseRetryAfterSeconds(null, now)).toBeUndefined();
  });
});
