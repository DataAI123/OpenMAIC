import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/health/route';
import { middleware } from '@/middleware';

const providerMocks = vi.hoisted(() => ({
  web: vi.fn(() => ({})),
  image: vi.fn(() => ({ image: { disabled: true } })),
  video: vi.fn(() => ({})),
  tts: vi.fn(() => ({ tts: { disabled: false } })),
}));
vi.mock('@/lib/server/provider-config', () => ({
  getServerWebSearchProviders: providerMocks.web,
  getServerImageProviders: providerMocks.image,
  getServerVideoProviders: providerMocks.video,
  getServerTTSProviders: providerMocks.tts,
}));

beforeEach(() => {
  providerMocks.web.mockReset().mockReturnValue({});
  providerMocks.image.mockReset().mockReturnValue({ image: { disabled: true } });
  providerMocks.video.mockReset().mockReturnValue({});
  providerMocks.tts.mockReset().mockReturnValue({ tts: { disabled: false } });
});

afterEach(() => vi.unstubAllEnvs());

describe('health access-code configuration', () => {
  it.each([undefined, '', 'health-route-test-secret', ' '])(
    'reports runtime configuration without exposing ACCESS_CODE=%j',
    async (code) => {
      vi.stubEnv('ACCESS_CODE', code);

      // Health remains available to deployment probes without an access cookie.
      const gate = await middleware(new NextRequest('http://localhost/api/health'));
      expect(gate.status).toBe(200);

      const response = await GET(
        new NextRequest('http://localhost/api/health', {
          headers: { 'x-request-id': 'health:access-code' },
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('health:access-code');
      expect(body).toEqual({
        success: true,
        status: 'ok',
        version: expect.any(String),
        accessCodeConfigured: Boolean(code),
        capabilities: {
          webSearch: false,
          imageGeneration: false,
          videoGeneration: false,
          tts: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain('health-route-test-secret');

      // The new diagnostic must not change the local-first default or gate.
      const api = await middleware(new NextRequest('http://localhost/api/foo'));
      expect(api.status).toBe(code ? 401 : 200);
    },
  );

  it('returns a redacted, correlated service error when provider configuration fails', async () => {
    providerMocks.image.mockImplementationOnce(() => {
      throw new Error('private provider configuration');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(
      new NextRequest('http://localhost/api/health', {
        headers: { 'x-request-id': 'health:failure' },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('health:failure');
    expect(await response.text()).not.toContain('private provider configuration');
    expect(errorLog).toHaveBeenCalledWith(
      '[health] failed to resolve capabilities (requestId=health:failure)',
      'Error',
    );
    errorLog.mockRestore();
  });
});
