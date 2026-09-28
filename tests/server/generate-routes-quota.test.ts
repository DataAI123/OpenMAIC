/**
 * Route-level integration guard for the personal media quota wiring.
 *
 * Where `media-quota-route.test.ts` pins the helper's skip/settle/fallback
 * logic, these tests pin the CONTRACT BETWEEN THE THREE GENERATE ROUTES AND
 * THAT HELPER: each route must reserve the right per-modality amount (image=1,
 * video=planned seconds, tts=input characters), map an exceeded gate to 429 and
 * an unavailable gate to 503 WITHOUT calling the provider, settle the real usage
 * on success, and settle `null` (conservative full charge) when the provider
 * itself throws. The routes stay behind the OIDC middleware 503 gate, so this
 * only exercises the reserved path that runs once a route is opened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  ownerId: 'user:1',
  beginMediaQuota: vi.fn(),
  settleMediaQuota: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateTTS: vi.fn(),
}));

// Inject a fixed owner and drive the handler synchronously so the reserved
// quota path (which only fires for `user:` owners) is exercised without a real
// OIDC session. `withOwnerResponseHeaders` still runs for real underneath.
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (
    _req: Request,
    handler: (ownerId: string, headers: Headers) => Promise<Response>,
  ) => handler(mocks.ownerId, new Headers()),
}));

vi.mock('@/lib/server/media-quota-route', () => ({
  beginMediaQuota: mocks.beginMediaQuota,
  settleMediaQuota: mocks.settleMediaQuota,
}));

// Permissive provider resolution so each route reaches the quota gate; the real
// error classes (e.g. TTSModelNotAllowedError) stay intact via importOriginal.
vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    isServerConfiguredProvider: () => false,
    isServerProviderDisabled: () => false,
    isServerTTSProviderDisabled: () => false,
    resolveServerImageProviderId: () => 'img-p',
    resolveServerVideoProviderId: () => 'vid-p',
    resolveImageApiKey: () => 'server-key',
    resolveImageBaseUrl: () => 'https://img.example/v1',
    resolveImageModel: () => 'img-model',
    resolveVideoApiKey: () => 'server-key',
    resolveVideoBaseUrl: () => 'https://vid.example/v1',
    resolveVideoModel: () => 'vid-model',
    resolveTTSApiKey: () => 'server-key',
    resolveTTSBaseUrl: () => 'https://tts.example/v1',
    resolveTTSModel: () => 'tts-model',
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

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

function jsonRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const reserved = (reservationId: string, reservedAmount: number) => ({
  kind: 'reserved' as const,
  reservationId,
  reservedAmount,
});

beforeEach(() => {
  vi.resetModules();
  mocks.ownerId = 'user:1';
  mocks.beginMediaQuota.mockReset();
  mocks.settleMediaQuota.mockReset().mockResolvedValue(undefined);
  mocks.generateImage.mockReset();
  mocks.generateVideo.mockReset();
  mocks.generateTTS.mockReset();
});

describe('POST /api/generate/image quota gate', () => {
  it('reserves one image and settles the real count on success', async () => {
    const gate = reserved('res-img', 1);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn/img.png' });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));

    expect(res.status).toBe(200);
    expect(mocks.beginMediaQuota).toHaveBeenCalledWith('user:1', 'image', 1);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, 1);
  });

  it('returns 429 RATE_LIMITED on an exceeded gate without calling the provider', async () => {
    mocks.beginMediaQuota.mockResolvedValue({ kind: 'exceeded' });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json).toMatchObject({ success: false, errorCode: 'RATE_LIMITED' });
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.settleMediaQuota).not.toHaveBeenCalled();
  });

  it('returns 503 on an unavailable gate without calling the provider', async () => {
    mocks.beginMediaQuota.mockResolvedValue({ kind: 'unavailable', reason: new Error('db down') });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));

    expect(res.status).toBe(503);
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('charges conservatively (null) when the provider itself throws', async () => {
    const gate = reserved('res-img', 1);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateImage.mockRejectedValue(new Error('upstream exploded'));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));

    expect(res.status).toBe(500);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, null);
  });
});

describe('POST /api/generate/video quota gate', () => {
  it('reserves the planned seconds and settles the rounded-up actual duration', async () => {
    const gate = reserved('res-vid', 8);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateVideo.mockResolvedValue({ url: 'v', duration: 8.4, width: 16, height: 9 });

    const { POST } = await import('@/app/api/generate/video/route');
    const res = await POST(jsonRequest('/api/generate/video', { prompt: 'a scene', duration: 8 }));

    expect(res.status).toBe(200);
    expect(mocks.beginMediaQuota).toHaveBeenCalledWith('user:1', 'video', 8);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, 9);
  });

  it('reserves a 1-second floor when the request omits a duration', async () => {
    const gate = reserved('res-vid', 1);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateVideo.mockResolvedValue({ url: 'v', duration: 5, width: 16, height: 9 });

    const { POST } = await import('@/app/api/generate/video/route');
    const res = await POST(jsonRequest('/api/generate/video', { prompt: 'a scene' }));

    expect(res.status).toBe(200);
    expect(mocks.beginMediaQuota).toHaveBeenCalledWith('user:1', 'video', 1);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, 5);
  });

  it('returns 429 on an exceeded video gate', async () => {
    mocks.beginMediaQuota.mockResolvedValue({ kind: 'exceeded' });

    const { POST } = await import('@/app/api/generate/video/route');
    const res = await POST(jsonRequest('/api/generate/video', { prompt: 'a scene', duration: 8 }));

    expect(res.status).toBe(429);
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });
});

describe('POST /api/generate/tts quota gate', () => {
  const ttsBody = (text: string) => ({
    text,
    audioId: 'audio-1',
    ttsProviderId: 'openai-tts',
    ttsVoice: 'alloy',
  });

  it('reserves and settles by input character count', async () => {
    const text = 'Hello world'; // 11 characters
    const gate = reserved('res-tts', text.length);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });

    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(jsonRequest('/api/generate/tts', ttsBody(text)));

    expect(res.status).toBe(200);
    expect(mocks.beginMediaQuota).toHaveBeenCalledWith('user:1', 'tts', 11);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, 11);
  });

  it('returns 429 on an exceeded TTS gate without calling the provider', async () => {
    mocks.beginMediaQuota.mockResolvedValue({ kind: 'exceeded' });

    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(jsonRequest('/api/generate/tts', ttsBody('Hello world')));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json).toMatchObject({ success: false, errorCode: 'RATE_LIMITED' });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('rejects oversized speech text with 400 BEFORE reserving any quota', async () => {
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(jsonRequest('/api/generate/tts', ttsBody('x'.repeat(100_001))));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(mocks.beginMediaQuota).not.toHaveBeenCalled();
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('charges conservatively (null) when the TTS provider throws', async () => {
    const gate = reserved('res-tts', 11);
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateTTS.mockRejectedValue(new Error('upstream exploded'));

    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(jsonRequest('/api/generate/tts', ttsBody('Hello world')));

    expect(res.status).toBe(500);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, null);
  });
});

describe('legacy anonymous owner', () => {
  it('still generates when the quota gate reports skip', async () => {
    mocks.ownerId = 'anon:xyz';
    const gate = { kind: 'skip' as const };
    mocks.beginMediaQuota.mockResolvedValue(gate);
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn/img.png' });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(jsonRequest('/api/generate/image', { prompt: 'a cat' }));

    expect(res.status).toBe(200);
    expect(mocks.beginMediaQuota).toHaveBeenCalledWith('anon:xyz', 'image', 1);
    expect(mocks.settleMediaQuota).toHaveBeenCalledWith(gate, 1);
  });
});
