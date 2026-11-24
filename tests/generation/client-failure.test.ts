import { describe, expect, it } from 'vitest';

import {
  classifyGenerationFailure,
  shouldRetryGenerationResult,
} from '@/lib/generation/client-failure';

describe('classifyGenerationFailure', () => {
  it.each([
    [{ statusCode: 401, errorCode: 'LOGIN_REQUIRED' }, 'login-required'],
    [{ statusCode: 401 }, 'login-required'],
    [{ statusCode: 403, errorCode: 'TENANT_REQUIRED' }, 'tenant-required'],
    [{ statusCode: 403 }, 'permission-denied'],
    [{ statusCode: 403, errorCode: 'FORBIDDEN' }, 'permission-denied'],
    [{ statusCode: 503, errorCode: 'AUTH_UNAVAILABLE' }, 'auth-unavailable'],
    [{ statusCode: 401, errorCode: 'MISSING_API_KEY' }, 'provider-auth-failed'],
    [{ statusCode: 429, errorCode: 'RATE_LIMITED' }, 'rate-limited'],
    [{ statusCode: 403, errorCode: 'PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED' }, 'quota-exceeded'],
    [{ statusCode: 503, errorCode: 'UPSTREAM_ERROR' }, 'provider-unavailable'],
    [{ statusCode: 400, errorCode: 'INVALID_REQUEST' }, 'invalid-request'],
    [{ statusCode: 500, errorCode: 'INTERNAL_ERROR' }, 'internal-error'],
    [{ statusCode: 400, errorCode: 'UNKNOWN' }, 'unknown'],
  ] as const)('maps %o to %s', (failure, expected) => {
    expect(classifyGenerationFailure(failure)).toBe(expected);
  });
});

describe('shouldRetryGenerationResult', () => {
  it.each([
    [{ success: false, statusCode: 401, errorCode: 'LOGIN_REQUIRED' }, true, false],
    [{ success: false, statusCode: 403, errorCode: 'TENANT_REQUIRED' }, true, false],
    [{ success: false, statusCode: 403, errorCode: 'FORBIDDEN' }, true, false],
    [{ success: false, statusCode: 429, errorCode: 'RATE_LIMITED' }, true, false],
    [
      { success: false, statusCode: 403, errorCode: 'PERSONAL_MEDIA_MONTHLY_QUOTA_EXCEEDED' },
      true,
      false,
    ],
    [{ success: false, statusCode: 503, errorCode: 'UPSTREAM_ERROR' }, true, true],
    [{ success: true, statusCode: 200 }, false, true],
    [{ success: true, statusCode: 200 }, true, false],
  ] as const)('evaluates %o with payload=%s: %s', (result, hasPayload, expected) => {
    expect(shouldRetryGenerationResult(result, hasPayload)).toBe(expected);
  });
});
