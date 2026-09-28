import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatePersistenceHeaders: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  resolveOidcAssetPrincipal: vi.fn(),
  identify: vi.fn(),
  resolve: vi.fn(),
  pool: {},
}));

vi.mock('@/lib/persistence/server-auth', () => ({
  authenticatePersistenceHeaders: mocks.authenticatePersistenceHeaders,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/persistence/oidc-asset-access', () => ({
  resolveOidcAssetPrincipal: mocks.resolveOidcAssetPrincipal,
}));

describe('resolveServerAsset principal selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://isolated.test/openmaic');
    mocks.authenticatePersistenceHeaders.mockReset().mockReturnValue({ key: 'shared' });
    mocks.resolveOidcAssetPrincipal.mockReset().mockResolvedValue({
      key: 'user:alice',
      learnerKey: 'user:alice',
    });
    mocks.identify.mockReset().mockResolvedValue({ byteLength: 5, mimeType: 'text/plain' });
    mocks.resolve.mockReset().mockResolvedValue({
      bytes: Buffer.from('hello'),
      mime: 'text/plain',
    });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: mocks.pool,
      assetStore: { identify: mocks.identify, resolve: mocks.resolve },
    });
  });

  it('authorizes OIDC asset reads with the verified user and ignores persistence credentials', async () => {
    const { resolveServerAsset } = await import('@/lib/persistence/resolve-server-asset');
    const headers = new Headers({ authorization: 'Bearer attacker-controlled-token' });

    await expect(
      resolveServerAsset('ast_private', headers, 100, 'user:alice'),
    ).resolves.toMatchObject({
      status: 'resolved',
      mimeType: 'text/plain',
    });

    expect(mocks.resolveOidcAssetPrincipal).toHaveBeenCalledWith(
      mocks.pool,
      'user:alice',
      {
        method: 'GET',
        url: 'http://persistence.internal/api/persistence/assets/ast_private/content',
      },
      undefined,
    );
    expect(mocks.authenticatePersistenceHeaders).not.toHaveBeenCalled();
    expect(mocks.identify).toHaveBeenCalledWith(
      { key: 'user:alice', learnerKey: 'user:alice' },
      'ast_private',
    );
    expect(mocks.resolve).toHaveBeenCalledWith(
      { key: 'user:alice', learnerKey: 'user:alice' },
      'ast_private',
    );
  });

  it('returns the same missing result for an asset outside the user principal', async () => {
    mocks.resolveOidcAssetPrincipal.mockResolvedValue(undefined);
    const { resolveServerAsset } = await import('@/lib/persistence/resolve-server-asset');

    await expect(
      resolveServerAsset('ast_foreign', new Headers(), 100, 'user:alice'),
    ).resolves.toEqual({
      status: 'missing',
    });
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('keeps the legacy shared principal path unchanged when no owner is supplied', async () => {
    const { resolveServerAsset } = await import('@/lib/persistence/resolve-server-asset');

    await expect(resolveServerAsset('ast_legacy', new Headers(), 100)).resolves.toMatchObject({
      status: 'resolved',
      mimeType: 'text/plain',
    });
    expect(mocks.authenticatePersistenceHeaders).toHaveBeenCalledOnce();
    expect(mocks.identify).toHaveBeenCalledWith({ key: 'shared' }, 'ast_legacy');
  });

  it('rejects oversized OIDC assets before reading their bytes', async () => {
    mocks.identify.mockResolvedValue({ byteLength: 101, mimeType: 'text/plain' });
    const { resolveServerAsset } = await import('@/lib/persistence/resolve-server-asset');

    await expect(
      resolveServerAsset('ast_large', new Headers(), 100, 'user:alice'),
    ).resolves.toEqual({
      status: 'too_large',
    });
    expect(mocks.identify).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
