import { describe, expect, it } from 'vitest';

import {
  mediaQuotaPeriodStart,
  reservePersonalMediaQuota,
  settlePersonalMediaQuota,
  type MediaQuotaModality,
} from '@/lib/server/personal-modality-quota';

describe('personal media quota guards (no database)', () => {
  it('uses the UTC calendar month boundary', () => {
    expect(mediaQuotaPeriodStart(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
    expect(mediaQuotaPeriodStart(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09-01');
    expect(mediaQuotaPeriodStart(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('rejects invalid dates and non-user owners before touching storage', async () => {
    expect(() => mediaQuotaPeriodStart(new Date('invalid'))).toThrow(/valid Date/);
    await expect(reservePersonalMediaQuota('anon:legacy', 'image', 1)).rejects.toThrow(
      'PERSONAL_MEDIA_QUOTA_REQUIRES_AUTHENTICATED_USER',
    );
  });

  it('rejects unreviewed modalities before any provider reservation', async () => {
    await expect(
      reservePersonalMediaQuota('user:alice', 'asr' as MediaQuotaModality, 1),
    ).rejects.toThrow(/modality must be one of/);
  });

  it('rejects zero, negative, fractional and unsafe reservation amounts', async () => {
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(reservePersonalMediaQuota('user:alice', 'video', amount)).rejects.toThrow(
        /reserveAmount must be a positive safe integer/,
      );
    }
  });

  it('rejects negative settle amounts before touching storage', async () => {
    await expect(settlePersonalMediaQuota('r-1', -1)).rejects.toThrow(
      /actualAmount must be a non-negative safe integer/,
    );
  });

  it('rejects an empty tenant id before touching storage', async () => {
    await expect(
      reservePersonalMediaQuota('user:alice', 'image', 1, new Date(), ''),
    ).rejects.toThrow(/tenantId must be a non-empty string/);
  });
});
