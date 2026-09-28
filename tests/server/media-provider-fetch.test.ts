import { afterEach, describe, expect, it, vi } from 'vitest';

// imageProviderFetch is the connect-time SSRF seam for image adapters: it must
// route ONLY the BYOK (client-supplied base URL) requests through the pinned
// transport, leave managed/env defaults on the plain global fetch, and forward
// the rejectRedirects escape-hatch option untouched.

const mocks = vi.hoisted(() => ({
  audioProviderFetch: vi.fn(),
}));

vi.mock('@/lib/server/audio-provider-fetch', () => ({
  audioProviderFetch: mocks.audioProviderFetch,
}));

import { imageProviderFetch, videoProviderFetch } from '@/lib/media/provider-fetch';

const RESOLVED = new Response('ok');

afterEach(() => {
  vi.restoreAllMocks();
  mocks.audioProviderFetch.mockReset();
});

describe('imageProviderFetch', () => {
  it('routes BYOK (pinSsrfConnections:true) through the pinned transport, not global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESOLVED);
    mocks.audioProviderFetch.mockResolvedValue(RESOLVED);

    const init: RequestInit = { method: 'POST', body: '{}' };
    await imageProviderFetch({ pinSsrfConnections: true }, 'https://byok.example/v1', init);

    expect(mocks.audioProviderFetch).toHaveBeenCalledTimes(1);
    expect(mocks.audioProviderFetch).toHaveBeenCalledWith('https://byok.example/v1', init, {
      rejectRedirects: undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards rejectRedirects to the pinned transport', async () => {
    mocks.audioProviderFetch.mockResolvedValue(RESOLVED);
    const init: RequestInit = { method: 'POST', redirect: 'manual' };

    await imageProviderFetch({ pinSsrfConnections: true }, 'https://byok.example/v1', init, {
      rejectRedirects: true,
    });

    expect(mocks.audioProviderFetch).toHaveBeenCalledWith('https://byok.example/v1', init, {
      rejectRedirects: true,
    });
  });

  it('leaves managed base URLs (flag unset) on the plain global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESOLVED);

    const init: RequestInit = { method: 'POST' };
    await imageProviderFetch({}, 'http://localhost:8188/prompt', init);

    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8188/prompt', init);
    expect(mocks.audioProviderFetch).not.toHaveBeenCalled();
  });

  it('treats pinSsrfConnections:false like unset (raw fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESOLVED);

    await imageProviderFetch({ pinSsrfConnections: false }, 'https://managed.example/v1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.audioProviderFetch).not.toHaveBeenCalled();
  });
});

describe('videoProviderFetch', () => {
  it('routes BYOK (pinSsrfConnections:true) through the pinned transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESOLVED);
    mocks.audioProviderFetch.mockResolvedValue(RESOLVED);

    const init: RequestInit = { method: 'POST', body: '{}' };
    await videoProviderFetch({ pinSsrfConnections: true }, 'https://byok.example/v1/videos', init);

    expect(mocks.audioProviderFetch).toHaveBeenCalledWith('https://byok.example/v1/videos', init, {
      rejectRedirects: undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards rejectRedirects (OpenRouter video keeps Authorization off-origin)', async () => {
    mocks.audioProviderFetch.mockResolvedValue(RESOLVED);
    const init: RequestInit = { method: 'GET', redirect: 'manual' };

    await videoProviderFetch(
      { pinSsrfConnections: true },
      'https://byok.example/v1/videos/x',
      init,
      {
        rejectRedirects: true,
      },
    );

    expect(mocks.audioProviderFetch).toHaveBeenCalledWith(
      'https://byok.example/v1/videos/x',
      init,
      {
        rejectRedirects: true,
      },
    );
  });

  it('leaves managed base URLs on the plain global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(RESOLVED);

    const init: RequestInit = { method: 'GET' };
    await videoProviderFetch({}, 'https://ark.cn-beijing.volces.com/tasks/1', init);

    expect(fetchSpy).toHaveBeenCalledWith('https://ark.cn-beijing.volces.com/tasks/1', init);
    expect(mocks.audioProviderFetch).not.toHaveBeenCalled();
  });
});
