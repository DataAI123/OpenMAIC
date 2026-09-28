import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The TTS generate route applies the STRICTEST BYOK base-URL posture of the three
// media routes: a client-supplied `ttsBaseUrl` is validated with
// `validatePublicUrlForSSRF`, which (by design) ignores the `ALLOW_LOCAL_NETWORKS`
// self-hosting escape hatch that the image/video lenient guard honors, and never
// permits cloud-metadata targets. The route's own comment calls this out ("Never
// derived from request input"); this locks that invariant so a later refactor
// cannot quietly loosen TTS to the image/video posture.

const mocks = vi.hoisted(() => ({
  generateTTS: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (
    _req: Request,
    handler: (ownerId: string, headers: Headers) => Promise<Response>,
  ) => handler('user:1', new Headers()),
}));

// Quota is orthogonal to the guard; always let the request reach the provider call.
vi.mock('@/lib/server/media-quota-route', () => ({
  beginMediaQuota: vi.fn(async () => ({ kind: 'skip' as const })),
  settleMediaQuota: vi.fn(async () => {}),
}));

// Force the BYOK (unmanaged) branch and keep client-supplied key/baseUrl verbatim;
// the real `validatePublicUrlForSSRF` (imported directly by the route) stays intact.
vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    isServerConfiguredProvider: () => false,
    isServerTTSProviderDisabled: () => false,
    resolveTTSApiKey: (_id: string, clientKey?: string) => clientKey,
    resolveTTSBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
    resolveTTSModel: (_id: string, clientModel?: string) => clientModel || 'tts-model',
  };
});

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function ttsRequest(ttsBaseUrl: string): NextRequest {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Hello world',
      audioId: 'audio-1',
      ttsProviderId: 'openai-tts',
      ttsVoice: 'alloy',
      ttsApiKey: 'client-key',
      ttsBaseUrl,
    }),
  });
}

describe('generate tts — client-supplied base URL uses the strict public-only guard in every environment', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    vi.resetModules();
    mocks.generateTTS.mockReset();
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a private-network base URL', async () => {
    const { POST } = await import('@/app/api/generate/tts/route');

    const res = await POST(ttsRequest('http://192.168.1.10/v1/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('does NOT honor ALLOW_LOCAL_NETWORKS for a request-derived base URL (strict, unlike image/video)', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/tts/route');

    const res = await POST(ttsRequest('http://192.168.1.10/v1/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('rejects a cloud-metadata base URL even with ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/tts/route');

    const res = await POST(ttsRequest('http://169.254.169.254/latest/meta-data/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('allows a public base URL and forwards it with the connect-time publicOnly flag set', async () => {
    const { POST } = await import('@/app/api/generate/tts/route');

    const res = await POST(ttsRequest('http://8.8.8.8/v1/'));

    expect(res.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-tts',
        apiKey: 'client-key',
        baseUrl: 'http://8.8.8.8/v1/',
        publicOnly: true,
      }),
      'Hello world',
    );
  });
});
