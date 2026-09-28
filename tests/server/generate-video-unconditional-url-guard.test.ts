import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mirror of `generate-image-unconditional-url-guard.test.ts` for the video route.
// A client-supplied BYOK provider base URL must be SSRF-validated in every
// environment, not only when NODE_ENV === 'production'. The self-hosting escape
// hatch is ALLOW_LOCAL_NETWORKS, which the real guard itself honors. The guard
// runs before any quota reservation or provider call, so an unsafe URL never
// reaches the network.

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
}));

vi.mock('@/lib/media/video-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/video-providers')>();
  return {
    ...actual,
    generateVideo: mocks.generateVideo,
    normalizeVideoOptions: (_providerId: string, body: Record<string, unknown>) => ({ ...body }),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const VIDEO_ENV_PREFIXES = [
  'VIDEO_SEEDANCE',
  'VIDEO_KLING',
  'VIDEO_VEO',
  'VIDEO_MINIMAX',
  'VIDEO_GROK',
  'VIDEO_HAPPYHORSE',
  'VIDEO_OPENROUTER',
];

function stubVideoEnvAbsent() {
  for (const prefix of VIDEO_ENV_PREFIXES) {
    vi.stubEnv(`${prefix}_API_KEY`, undefined);
    vi.stubEnv(`${prefix}_BASE_URL`, undefined);
    vi.stubEnv(`${prefix}_MODELS`, undefined);
    vi.stubEnv(`${prefix}_ENABLED`, undefined);
  }
}

function videoRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/generate/video', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a scene', duration: 8 }),
  });
}

const BYOK_HEADERS = {
  'x-video-provider': 'minimax-video',
  'x-api-key': 'client-key',
  'x-video-model': 'MiniMax-Hailuo-02',
  'x-base-url': 'http://192.168.1.10/v1/',
};

describe('generate video — client-supplied base URL guard applies in every environment', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubVideoEnvAbsent();
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    vi.resetModules();
    mocks.generateVideo.mockReset();
    mocks.generateVideo.mockResolvedValue({
      url: 'https://example.com/v.mp4',
      duration: 8,
      width: 16,
      height: 9,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a private-network base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { POST } = await import('@/app/api/generate/video/route');

    const res = await POST(videoRequest(BYOK_HEADERS));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it('still allows a private-network base URL when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/video/route');

    const res = await POST(videoRequest(BYOK_HEADERS));

    expect(res.status).toBe(200);
    expect(mocks.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'minimax-video',
        apiKey: 'client-key',
        model: 'MiniMax-Hailuo-02',
        baseUrl: 'http://192.168.1.10/v1/',
        pinSsrfConnections: true,
      }),
      expect.anything(),
    );
  });
});
