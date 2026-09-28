import { describe, expect, it } from 'vitest';

import { llmQuotaPeriodStart, reservePersonalLlmTokens } from '@/lib/server/personal-llm-quota';

describe('personal LLM quota policy', () => {
  it('uses the UTC calendar month boundary', () => {
    expect(llmQuotaPeriodStart(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
    expect(llmQuotaPeriodStart(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09-01');
    expect(llmQuotaPeriodStart(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('rejects invalid dates and non-user owners before touching storage', async () => {
    expect(() => llmQuotaPeriodStart(new Date('invalid'))).toThrow(/valid Date/);
    await expect(reservePersonalLlmTokens('anon:legacy', 100)).rejects.toThrow(
      'PERSONAL_LLM_QUOTA_REQUIRES_AUTHENTICATED_USER',
    );
  });

  it('rejects zero, negative, fractional, and unsafe reservation amounts', async () => {
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(reservePersonalLlmTokens('user:alice', amount)).rejects.toThrow(
        /reserveTokens must be a positive safe integer/,
      );
    }
  });
});
