import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  getAgentSessionStore: vi.fn(),
  softDeleteSession: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: mocks.headers,
  cookies: mocks.cookies,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  anonymousCookieSecure: () => true,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));
vi.mock('@/lib/server/auth/config', () => ({
  resolveAuthConfig: mocks.resolveAuthConfig,
}));
vi.mock('@/lib/server/auth/session', () => ({
  resolveApplicationSession: mocks.resolveApplicationSession,
}));

const appOrigin = 'https://openmaic.example.com';

describe('deleteWorkspaceSession Server Action authorization', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.headers.mockReset().mockResolvedValue(new Headers({ origin: appOrigin }));
    mocks.cookieGet.mockReset().mockReturnValue(undefined);
    mocks.cookieSet.mockReset();
    mocks.cookies.mockReset().mockResolvedValue({ get: mocks.cookieGet, set: mocks.cookieSet });
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin });
    mocks.resolveApplicationSession.mockReset().mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'internal-user-1',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
      },
    });
    mocks.softDeleteSession.mockReset().mockResolvedValue(true);
    mocks.getAgentSessionStore.mockReset().mockResolvedValue({
      softDeleteSession: mocks.softDeleteSession,
    });
  });

  async function deleteSession(id: string) {
    const { deleteWorkspaceSession } = await import('@/lib/workbench/workspace-actions');
    return deleteWorkspaceSession(id);
  }

  it('uses the database session owner for a same-origin deletion', async () => {
    await expect(deleteSession(' session-42 ')).resolves.toEqual({ deleted: true });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-42', 'user:internal-user-1');
  });

  it.each([
    ['missing', { status: 'missing' }],
    ['invalid', { status: 'invalid' }],
    ['unavailable', { status: 'unavailable' }],
  ] as const)('rejects %s OIDC sessions before storage access', async (_label, result) => {
    mocks.resolveApplicationSession.mockResolvedValue(result);
    await expect(deleteSession('session-42')).rejects.toThrow(
      result.status === 'unavailable' ? 'AUTH_UNAVAILABLE' : 'LOGIN_REQUIRED',
    );
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
    expect(mocks.getAgentSessionStore).not.toHaveBeenCalled();
  });

  it('rejects viewers and cross-origin requests before storage access', async () => {
    mocks.resolveApplicationSession.mockResolvedValueOnce({
      status: 'authenticated',
      session: {
        userId: 'viewer-1',
        sessionId: 'session-viewer',
        tenantId: 'default',
        role: 'viewer',
      },
    });
    await expect(deleteSession('session-42')).rejects.toThrow('FORBIDDEN');
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();

    mocks.headers.mockResolvedValueOnce(new Headers({ origin: 'https://attacker.example' }));
    await expect(deleteSession('session-42')).rejects.toThrow('INVALID_ORIGIN');
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
  });

  it('authenticates even when the action input is empty', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'missing' });
    await expect(deleteSession('   ')).rejects.toThrow('LOGIN_REQUIRED');
    expect(mocks.getAgentSessionStore).not.toHaveBeenCalled();
  });

  it('keeps deletion owner-scoped when the store reports a foreign or absent session', async () => {
    mocks.softDeleteSession.mockResolvedValue(false);
    await expect(deleteSession('foreign-session')).resolves.toEqual({ deleted: false });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('foreign-session', 'user:internal-user-1');
  });

  it('retains validated legacy anonymous ownership', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    mocks.cookieGet.mockReturnValue({ value: '7d8e72ca-f6cb-4b86-9983-0cbfa1cb9f89' });
    await expect(deleteSession('session-42')).resolves.toEqual({ deleted: true });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith(
      'session-42',
      'anon:7d8e72ca-f6cb-4b86-9983-0cbfa1cb9f89',
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
