import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModelsUrlCandidates, fetchModels, ModelFetchError } from '@/lib/server/model-fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildModelsUrlCandidates', () => {
  it('plain root → /v1/models', () => {
    expect(buildModelsUrlCandidates('https://api.siliconflow.cn')).toEqual([
      'https://api.siliconflow.cn/v1/models',
    ]);
  });

  it('strips a trailing slash', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('base ending in /v1 → {base}/models (no double /v1)', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/v1')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('zhipu coding paas/v4 → /models first, /v1/models fallback', () => {
    expect(buildModelsUrlCandidates('https://open.bigmodel.cn/api/coding/paas/v4')).toEqual([
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
      'https://open.bigmodel.cn/api/coding/paas/v4/v1/models',
    ]);
  });

  it('explicit override wins and is the only candidate', () => {
    expect(
      buildModelsUrlCandidates('https://x.com/v1', {
        modelsUrlOverride: 'https://x.com/custom/models',
      }),
    ).toEqual(['https://x.com/custom/models']);
  });

  it('base ending exactly in a compat suffix → strips it and appends fallbacks', () => {
    // Suffix-strip only triggers when the base ENDS with the suffix.
    const c = buildModelsUrlCandidates('https://api.minimaxi.com/anthropic');
    // not a version segment → {base}/v1/models first
    expect(c[0]).toBe('https://api.minimaxi.com/anthropic/v1/models');
    // then stripped-suffix fallbacks
    expect(c).toContain('https://api.minimaxi.com/v1/models');
    expect(c).toContain('https://api.minimaxi.com/models');
  });

  it('base .../anthropic/v1 keeps the version segment (no strip)', () => {
    // ends in /v1, not the compat suffix → only {base}/models.
    expect(buildModelsUrlCandidates('https://api.minimaxi.com/anthropic/v1')).toEqual([
      'https://api.minimaxi.com/anthropic/v1/models',
    ]);
  });

  it('longest compat suffix wins (/api/anthropic over /anthropic)', () => {
    const c = buildModelsUrlCandidates('https://gw.example.com/api/anthropic');
    expect(c).toContain('https://gw.example.com/v1/models');
    expect(c).toContain('https://gw.example.com/models');
  });

  it('throws on empty base url', () => {
    expect(() => buildModelsUrlCandidates('   ')).toThrow();
  });

  it('dedupes candidates preserving order', () => {
    const c = buildModelsUrlCandidates('https://api.example.com');
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('fetchModels', () => {
  it('returns a sorted model list from a successful response without following redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'z-model', owned_by: 'provider' }, { id: 'a-model' }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchModels('https://api.example.com', 'test-key')).resolves.toEqual([
      { id: 'a-model', ownedBy: undefined },
      { id: 'z-model', ownedBy: 'provider' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-key' },
        redirect: 'manual',
      }),
    );
  });

  it.each([301, 302, 307, 308])(
    'rejects upstream %i without reading its body or trying another candidate',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('redirect response body', { status }));
      vi.stubGlobal('fetch', fetchMock);

      const error = await fetchModels(
        'https://gateway.example.com/api/anthropic',
        'test-key',
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ModelFetchError);
      expect(error).toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://gateway.example.com/api/anthropic/v1/models',
        expect.objectContaining({ redirect: 'manual' }),
      );
    },
  );

  it.each([404, 405])(
    'falls back after %i and keeps redirect handling manual for every candidate',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unused error content', { status }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'fallback-model' }] }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        fetchModels('https://gateway.example.com/api/anthropic', 'test-key'),
      ).resolves.toEqual([{ id: 'fallback-model', ownedBy: undefined }]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://gateway.example.com/api/anthropic/v1/models',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://gateway.example.com/v1/models',
        expect.objectContaining({ redirect: 'manual' }),
      );
    },
  );

  it.each([401, 403])('keeps upstream %i terminal and preserves its status', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid key', { status }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchModels('https://api.example.com', 'bad-key').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ModelFetchError);
    expect(error).toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as Error).message).not.toContain('invalid key');
  });

  it('rejects an oversized successful response without parsing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(' '.repeat(256 * 1024 + 1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await fetchModels('https://api.example.com', '').catch((caught) => caught);
    expect(error).toBeInstanceOf(ModelFetchError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).not.toContain(' '.repeat(64));
  });
});
