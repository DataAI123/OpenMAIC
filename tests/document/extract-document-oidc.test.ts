import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  resolveServerAsset: vi.fn(),
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
vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveServerAsset: mocks.resolveServerAsset,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('POST /api/extract-document OIDC identity boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
    mocks.resolveServerAsset.mockReset().mockResolvedValue({ status: 'missing' });
    mocks.consumeActionRateLimit.mockClear();
  });

  it('requires the shared database-backed owner boundary and marks uploaded results private', async () => {
    const formData = new FormData();
    formData.append(
      'file',
      new File(['private course notes'], 'notes.txt', { type: 'text/plain' }),
    );
    const request = new Request('https://openmaic.example.com/api/extract-document', {
      method: 'POST',
      headers: { origin: 'https://openmaic.example.com' },
      body: formData,
    });

    const { POST } = await import('@/app/api/extract-document/route');
    const response = await POST(request as unknown as NextRequest);

    expect(mocks.withRequestOwnerId).toHaveBeenCalledOnce();
    expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(request, expect.any(Function));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  it('resolves asset-id input with the verified user owner, never the persistence headers alone', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('private course notes'),
      mimeType: 'text/plain',
    });
    const request = new Request('https://openmaic.example.com/api/extract-document', {
      method: 'POST',
      headers: {
        origin: 'https://openmaic.example.com',
        'content-type': 'application/json',
        authorization: 'Bearer attacker-controlled-persistence-token',
      },
      body: JSON.stringify({ assetId: 'asset-private', fileName: 'notes.txt' }),
    });

    const { POST } = await import('@/app/api/extract-document/route');
    const response = await POST(request as unknown as NextRequest);

    expect(mocks.resolveServerAsset).toHaveBeenCalledWith(
      'asset-private',
      request.headers,
      50 * 1024 * 1024,
      'user:alice',
      'default',
    );
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:alice', 'extract_document');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns 429 with Retry-After without parsing when the action window is exhausted', async () => {
    mocks.consumeActionRateLimit.mockRejectedValueOnce(new mocks.UserApiRateLimitExceededError(41));
    const request = new Request('https://openmaic.example.com/api/extract-document', {
      method: 'POST',
      headers: {
        origin: 'https://openmaic.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetId: 'asset-private', fileName: 'notes.txt' }),
    });

    const { POST } = await import('@/app/api/extract-document/route');
    const response = await POST(request as unknown as NextRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('41');
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('does not parse or process the upload when the owner boundary rejects the request', async () => {
    mocks.withRequestOwnerId.mockResolvedValue(
      Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 }),
    );
    const formData = new FormData();
    formData.append(
      'file',
      new File(['private course notes'], 'notes.txt', { type: 'text/plain' }),
    );
    const request = new Request('https://openmaic.example.com/api/extract-document', {
      method: 'POST',
      headers: { origin: 'https://openmaic.example.com' },
      body: formData,
    });

    const { POST } = await import('@/app/api/extract-document/route');
    const response = await POST(request as unknown as NextRequest);

    expect(response.status).toBe(401);
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns a correlated sanitized error when auth configuration is unavailable', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('private configuration details');
    });
    const request = new Request('https://openmaic.example.com/api/extract-document', {
      method: 'POST',
      headers: { 'x-request-id': 'extract-auth-config-failure' },
    });

    const { POST } = await import('@/app/api/extract-document/route');
    const response = await POST(request as unknown as NextRequest);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('extract-auth-config-failure');
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain('private configuration details');
  });
});
