import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  transcribeAudio: vi.fn(),
  loggerError: vi.fn(),
  findUnsafeNetworkTargetError: vi.fn(),
  consumeActionRateLimit: vi.fn(async (_ownerId: string, _routeKey: string) => undefined),
  UserApiRateLimitExceededError: class UserApiRateLimitExceededError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('User API rate limit exceeded');
    }
  },
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/audio/asr-providers', () => ({ transcribeAudio: mocks.transcribeAudio }));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => false,
  isServerProviderDisabled: () => false,
  resolveASRApiKey: (_provider: string, key?: string) => key ?? '',
  resolveASRBaseUrl: (_provider: string, baseUrl?: string) => baseUrl,
  resolveASRModel: (_provider: string, model?: string) => model,
  resolveServerASRProviderId: () => undefined,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({
  findUnsafeNetworkTargetError: mocks.findUnsafeNetworkTargetError,
  validatePublicUrlForSSRF: async () => null,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.loggerError, debug: vi.fn() }),
}));

function request(): Request {
  const body = new FormData();
  body.append('audio', new File(['audio bytes'], 'private.mp3', { type: 'audio/mpeg' }));
  body.append('providerId', 'openai');
  body.append('modelId', 'whisper-1');
  return new Request('https://openmaic.example.com/api/transcription', {
    method: 'POST',
    headers: { origin: 'https://openmaic.example.com' },
    body,
  });
}

describe('POST /api/transcription OIDC identity boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
    mocks.transcribeAudio.mockReset().mockResolvedValue({ text: 'recognized speech' });
    mocks.consumeActionRateLimit.mockClear();
    mocks.loggerError.mockReset();
    mocks.findUnsafeNetworkTargetError.mockReset().mockReturnValue(null);
  });

  it('requires the owner boundary and keeps transcript responses private', async () => {
    const req = request();
    const { POST } = await import('@/app/api/transcription/route');
    const response = await POST(req as unknown as NextRequest);

    expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(req, expect.any(Function));
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:alice', 'transcription');
    expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ text: 'recognized speech' });
  });

  it('returns 429 with Retry-After without transcribing when the action window is exhausted', async () => {
    mocks.consumeActionRateLimit.mockRejectedValueOnce(new mocks.UserApiRateLimitExceededError(12));
    const { POST } = await import('@/app/api/transcription/route');
    const response = await POST(request() as unknown as NextRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it('does not transcribe when the owner boundary rejects the request', async () => {
    mocks.withRequestOwnerId.mockResolvedValue(
      Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 }),
    );
    const { POST } = await import('@/app/api/transcription/route');

    await expect(POST(request() as unknown as NextRequest)).resolves.toHaveProperty('status', 401);
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it('hides ASR provider errors and does not log user-selected provider details', async () => {
    mocks.transcribeAudio.mockRejectedValue(new Error('private provider response and endpoint'));
    const { POST } = await import('@/app/api/transcription/route');
    const response = await POST(request() as unknown as NextRequest);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('private provider response');
    expect(mocks.loggerError).toHaveBeenCalledWith('Transcription failed for an OIDC request');
  });

  it('preserves the legacy route without requiring an OIDC owner boundary', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    const { POST } = await import('@/app/api/transcription/route');
    const response = await POST(request() as unknown as NextRequest);

    expect(mocks.withRequestOwnerId).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
