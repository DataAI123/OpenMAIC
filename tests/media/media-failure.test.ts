import { describe, expect, it } from 'vitest';
import { mediaFailureNoticeKey, mediaFailureRecovery } from '@/lib/media/media-failure';

describe('media failure recovery', () => {
  it.each([
    ['LOGIN_REQUIRED', 'login'],
    ['TENANT_REQUIRED', 'tenant'],
    ['INVALID_CREDENTIALS', 'retry'],
    [undefined, 'retry'],
  ] as const)('routes %s to %s recovery', (errorCode, recovery) => {
    expect(mediaFailureRecovery(errorCode)).toBe(recovery);
  });

  it.each([
    ['LOGIN_REQUIRED', 'settings.mediaAuthRequired'],
    ['TENANT_REQUIRED', 'settings.mediaAuthRequired'],
    ['AUTH_UNAVAILABLE', 'auth.unavailable'],
    ['FORBIDDEN', 'generation.permissionDenied'],
    ['MISSING_API_KEY', 'generation.sceneGenerateAuthFailed'],
    ['INVALID_CREDENTIALS', 'generation.sceneGenerateAuthFailed'],
    ['CONTENT_SENSITIVE', 'settings.mediaContentSensitive'],
    ['ASSET_QUOTA_EXCEEDED', 'settings.mediaStorageFull'],
  ])('maps %s to a safe user notice', (errorCode, key) => {
    expect(mediaFailureNoticeKey(errorCode)).toBe(key);
  });
});
