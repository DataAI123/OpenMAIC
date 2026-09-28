/**
 * Error-detail redaction guard for the image/video generate routes.
 *
 * A server-managed (admin-owned) provider's upstream error body is meant for the
 * operator, not the calling user: it can carry account, quota, or internal
 * detail. When a managed provider throws, the route must return a generic 500
 * message. A BYOK/unmanaged caller owns the provider account, so the provider
 * message must survive so they can debug their own configuration. Either way the
 * full text stays in the server log; only the client-visible body differs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  managed: false,
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (
    _req: Request,
    handler: (ownerId: string, headers: Headers) => Promise<Response>,
  ) => handler('user:1', new Headers()),
}));

// Quota is orthogonal here; always let the request reach the provider call.
vi.mock('@/lib/server/media-quota-route', () => ({
  beginMediaQuota: vi.fn(async () => ({ kind: 'skip' as const })),
  settleMediaQuota: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    isServerConfiguredProvider: () => mocks.managed,
    isServerProviderDisabled: () => false,
    resolveServerImageProviderId: () => 'img-p',
    resolveServerVideoProviderId: () => 'vid-p',
    resolveImageApiKey: () => 'server-key',
    resolveImageBaseUrl: () => 'https://img.example/v1',
    resolveImageModel: () => 'img-model',
    resolveVideoApiKey: () => 'server-key',
    resolveVideoBaseUrl: () => 'https://vid.example/v1',
    resolveVideoModel: () => 'vid-model',
  };
});

vi.mock('@/lib/media/image-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/image-providers')>();
  const imageProviders = {
    ...actual.IMAGE_PROVIDERS,
    'img-p': { requiresApiKey: true, models: [{ id: 'img-model' }] },
  };
  return { ...actual, IMAGE_PROVIDERS: imageProviders, generateImage: mocks.generateImage };
});

vi.mock('@/lib/media/video-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/video-providers')>();
  return {
    ...actual,
    generateVideo: mocks.generateVideo,
    normalizeVideoOptions: (_providerId: string, body: Record<string, unknown>) => ({ ...body }),
  };
});

function jsonRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SECRET = 'upstream 402: operator account sk-live-XYZ over monthly quota';

beforeEach(() => {
  vi.resetModules();
  mocks.managed = false;
  mocks.generateImage.mockReset();
  mocks.generateVideo.mockReset();
});

describe('managed provider error redaction', () => {
  it('generics the image 500 body for a managed provider', async () => {
    mocks.managed = true;
    mocks.generateImage.mockRejectedValue(new Error(SECRET));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.errorCode).toBe('INTERNAL_ERROR');
    expect(json.error).not.toContain(SECRET);
    expect(json.error).toBe('Image generation failed. Please try again.');
  });

  it('generics the video 500 body for a managed provider', async () => {
    mocks.managed = true;
    mocks.generateVideo.mockRejectedValue(new Error(SECRET));

    const { POST } = await import('@/app/api/generate/video/route');
    const res = await POST(jsonRequest('/api/generate/video', { prompt: 'a scene', duration: 8 }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.errorCode).toBe('INTERNAL_ERROR');
    expect(json.error).not.toContain(SECRET);
    expect(json.error).toBe('Video generation failed. Please try again.');
  });
});

describe('BYOK (unmanaged) provider error passthrough', () => {
  it('preserves the image provider message for an unmanaged caller', async () => {
    mocks.managed = false;
    mocks.generateImage.mockRejectedValue(new Error(SECRET));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain(SECRET);
  });

  it('preserves the video provider message for an unmanaged caller', async () => {
    mocks.managed = false;
    mocks.generateVideo.mockRejectedValue(new Error(SECRET));

    const { POST } = await import('@/app/api/generate/video/route');
    const res = await POST(jsonRequest('/api/generate/video', { prompt: 'a scene', duration: 8 }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain(SECRET);
  });
});
