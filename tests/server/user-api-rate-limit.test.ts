import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

describe('Azure voices user API rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses its own route key and the shared five-request fixed window', async () => {
    const { consumeAzureVoicesRateLimit } = await import('@/lib/server/user-api-rate-limit');
    await expect(consumeAzureVoicesRateLimit('user:internal-user')).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['default', 'internal-user', 'azure_voices', 5]);
  });

  it('rejects legacy anonymous owners before database access', async () => {
    const { consumeAzureVoicesRateLimit } = await import('@/lib/server/user-api-rate-limit');
    await expect(consumeAzureVoicesRateLimit('anon:legacy-owner')).rejects.toThrow(
      'USER_API_RATE_LIMIT_REQUIRES_AUTHENTICATED_USER',
    );
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });

  it('throws a retry delay when the route window is exhausted', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ retry_after: 19 }] });
    const { consumeAzureVoicesRateLimit, UserApiRateLimitExceededError } =
      await import('@/lib/server/user-api-rate-limit');

    await expect(consumeAzureVoicesRateLimit('user:internal-user')).rejects.toMatchObject({
      constructor: UserApiRateLimitExceededError,
      retryAfterSeconds: 19,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});

describe('PDF provider verification user API rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses its own route key and the shared five-request fixed window', async () => {
    const { consumePdfProviderVerificationRateLimit } =
      await import('@/lib/server/user-api-rate-limit');
    await expect(
      consumePdfProviderVerificationRateLimit('user:internal-user'),
    ).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'default',
      'internal-user',
      'verify_pdf_provider',
      5,
    ]);
  });
});

describe('Image provider verification user API rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses its own route key in the shared five-request fixed window', async () => {
    const { consumeImageProviderVerificationRateLimit } =
      await import('@/lib/server/user-api-rate-limit');
    await expect(
      consumeImageProviderVerificationRateLimit('user:internal-user'),
    ).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'default',
      'internal-user',
      'verify_image_provider',
      5,
    ]);
  });
});

describe('Video provider verification user API rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses its own route key in the shared five-request fixed window', async () => {
    const { consumeVideoProviderVerificationRateLimit } =
      await import('@/lib/server/user-api-rate-limit');
    await expect(
      consumeVideoProviderVerificationRateLimit('user:internal-user'),
    ).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'default',
      'internal-user',
      'verify_video_provider',
      5,
    ]);
  });
});

describe('Action route user API rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the action route key into the shared five-request fixed window', async () => {
    const { consumeActionRateLimit } = await import('@/lib/server/user-api-rate-limit');
    await expect(
      consumeActionRateLimit('user:internal-user', 'pbl_v2_instructor'),
    ).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'default',
      'internal-user',
      'pbl_v2_instructor',
      5,
    ]);
  });

  it('keys the window by the request tenant when the attribution carries one', async () => {
    const { consumeActionRateLimit } = await import('@/lib/server/user-api-rate-limit');
    const { runWithUsageAttribution } = await import('@/lib/server/usage-attribution');

    await runWithUsageAttribution({ ownerId: 'user:internal-user', tenantId: 'tenant-a' }, () =>
      consumeActionRateLimit('user:internal-user', 'pbl_v2_instructor'),
    );

    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'tenant-a',
      'internal-user',
      'pbl_v2_instructor',
      5,
    ]);
  });

  it('skips legacy anonymous owners before database access', async () => {
    const { consumeActionRateLimit } = await import('@/lib/server/user-api-rate-limit');
    await expect(consumeActionRateLimit('anon:legacy-owner', 'api_chat')).resolves.toBeUndefined();
    await expect(consumeActionRateLimit('public:anonymous', 'quiz_grade')).resolves.toBeUndefined();
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });
});
