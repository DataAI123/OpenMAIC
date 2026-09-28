import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Fourth BYOK media surface: the voice-registration route. Like the TTS route it
// validates a client-supplied `ttsBaseUrl` with the STRICT `validatePublicUrlForSSRF`
// (public-only, ignores ALLOW_LOCAL_NETWORKS), which is the reference posture. This
// locks the guard so a later refactor cannot quietly loosen voice to the lenient
// image/video posture, and confirms the connect-time `publicOnly` flag is forwarded
// to the provider adapter once the URL passes.

const mocks = vi.hoisted(() => ({
  adapter: {
    deleteVoice: vi.fn(),
    voiceExists: vi.fn(),
    registerVoice: vi.fn(),
    bootstrapReferenceClip: vi.fn(),
  },
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    // Force the BYOK (unmanaged) branch and keep the client key/baseUrl verbatim;
    // the real `validatePublicUrlForSSRF` (imported directly by the route) stays.
    isServerConfiguredProvider: () => false,
    isServerTTSProviderDisabled: () => false,
    resolveTTSApiKey: (_id: string, clientKey?: string) => clientKey,
    resolveTTSBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
    resolveTTSModel: (_id: string, clientModel?: string) => clientModel || 'voice-model',
    resolveQwenVoiceCloneModel: () => 'qwen-voice-model',
  };
});

vi.mock('@/lib/audio/voice-registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/voice-registration')>();
  return { ...actual, getVoiceRegistrationAdapter: () => mocks.adapter };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// The `delete` action exercises the same entry guard as registration while keeping
// the post-guard path to a single adapter call, so the test isolates the guard.
function voiceRequest(ttsBaseUrl: string): NextRequest {
  return new NextRequest('http://localhost/api/generate/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId: 'voice-1',
      action: 'delete',
      ttsApiKey: 'client-key',
      ttsBaseUrl,
    }),
  });
}

describe('generate voice — client-supplied base URL uses the strict public-only guard in every environment', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    vi.resetModules();
    mocks.adapter.deleteVoice.mockReset();
    mocks.adapter.deleteVoice.mockResolvedValue(undefined);
    mocks.adapter.voiceExists.mockReset();
    mocks.adapter.registerVoice.mockReset();
    mocks.adapter.bootstrapReferenceClip.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a private-network base URL before reaching the provider', async () => {
    const { POST } = await import('@/app/api/generate/voice/route');

    const res = await POST(voiceRequest('http://192.168.1.10/v1/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('does NOT honor ALLOW_LOCAL_NETWORKS for a request-derived base URL (strict)', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/voice/route');

    const res = await POST(voiceRequest('http://192.168.1.10/v1/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('rejects a cloud-metadata base URL even with ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/voice/route');

    const res = await POST(voiceRequest('http://169.254.169.254/latest/meta-data/'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('allows a public base URL and forwards it with the connect-time publicOnly flag set', async () => {
    const { POST } = await import('@/app/api/generate/voice/route');

    const res = await POST(voiceRequest('http://8.8.8.8/v1/'));

    expect(res.status).toBe(200);
    expect(mocks.adapter.deleteVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://8.8.8.8/v1/',
        apiKey: 'client-key',
        publicOnly: true,
      }),
      'voice-1',
      expect.anything(),
    );
  });
});
