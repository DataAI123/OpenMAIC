import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  getServerProviders: vi.fn(),
  getServerTTSProviders: vi.fn(),
  getServerASRProviders: vi.fn(),
  getServerPDFProviders: vi.fn(),
  getServerImageProviders: vi.fn(),
  getServerVideoProviders: vi.fn(),
  getServerWebSearchProviders: vi.fn(),
  getParallelSceneConcurrency: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: mocks.getServerProviders,
  getServerTTSProviders: mocks.getServerTTSProviders,
  getServerASRProviders: mocks.getServerASRProviders,
  getServerPDFProviders: mocks.getServerPDFProviders,
  getServerImageProviders: mocks.getServerImageProviders,
  getServerVideoProviders: mocks.getServerVideoProviders,
  getServerWebSearchProviders: mocks.getServerWebSearchProviders,
  getParallelSceneConcurrency: mocks.getParallelSceneConcurrency,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import { GET } from '@/app/api/server-providers/route';

describe('GET /api/server-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerProviders.mockReturnValue({ openai: { models: ['gpt-test'] } });
    mocks.getServerTTSProviders.mockReturnValue({ 'openai-tts': {} });
    mocks.getServerASRProviders.mockReturnValue({});
    mocks.getServerPDFProviders.mockReturnValue({});
    mocks.getServerImageProviders.mockReturnValue({});
    mocks.getServerVideoProviders.mockReturnValue({});
    mocks.getServerWebSearchProviders.mockReturnValue({});
    mocks.getParallelSceneConcurrency.mockReturnValue(3);
    mocks.withRequestOwnerId.mockImplementation(async (_request, handler) =>
      handler('user:alice', new Headers({ 'Set-Cookie': 'openmaic_owner=legacy-owner' })),
    );
  });

  it('requires the shared owner/session boundary and returns only uncached capability metadata', async () => {
    const request = new NextRequest('https://openmaic.example.com/api/server-providers');
    const response = await GET(request);
    const body = await response.json();

    expect(mocks.withRequestOwnerId).toHaveBeenCalledOnce();
    expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(request, expect.any(Function));
    expect(body).toMatchObject({
      success: true,
      providers: { openai: { models: ['gpt-test'] } },
      tts: { 'openai-tts': {} },
      generation: { parallelSceneConcurrency: 3 },
    });
    expect(JSON.stringify(body)).not.toMatch(/apiKey|baseUrl|proxy|secret/i);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=legacy-owner');
  });

  it('keeps capability responses available to the legacy owner boundary', async () => {
    const legacyHeaders = new Headers({ 'Set-Cookie': 'openmaic_owner=anon-owner' });
    mocks.withRequestOwnerId.mockImplementationOnce(async (_request, handler) =>
      handler('anon:owner', legacyHeaders),
    );

    const response = await GET(
      new NextRequest('https://openmaic.example.com/api/server-providers'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=anon-owner');
  });

  it('keeps failures uncached and preserves owner-resolution headers', async () => {
    mocks.getServerProviders.mockImplementationOnce(() => {
      throw new Error('provider config unavailable');
    });

    const response = await GET(
      new NextRequest('https://openmaic.example.com/api/server-providers'),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=legacy-owner');
  });
});
