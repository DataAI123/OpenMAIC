import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  resolveApplicationSession: mocks.resolveApplicationSession,
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
}));

async function loadAuthRoutes() {
  const [login, callback, logout, session] = await Promise.all([
    import('@/app/api/auth/login/route'),
    import('@/app/api/auth/callback/route'),
    import('@/app/api/auth/logout/route'),
    import('@/app/api/auth/session/route'),
  ]);
  return { login, callback, logout, session };
}

describe('authentication route request ids', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'legacy' });
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
  });

  it('stamps login refusal, session success, and logout success responses', async () => {
    const { login, session, logout } = await loadAuthRoutes();
    const loginResponse = await login.GET(
      new NextRequest('https://openmaic.example.com/api/auth/login', {
        headers: { 'x-request-id': 'auth-login:refused' },
      }),
    );
    const sessionResponse = await session.GET(
      new NextRequest('https://openmaic.example.com/api/auth/session', {
        headers: { 'x-request-id': 'auth-session:guest' },
      }),
    );
    const logoutResponse = await logout.POST(
      new NextRequest('https://openmaic.example.com/api/auth/logout', {
        method: 'POST',
        headers: { 'x-request-id': 'auth-logout:success' },
      }),
    );

    expect(loginResponse.status).toBe(404);
    expect(loginResponse.headers.get('x-request-id')).toBe('auth-login:refused');
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get('x-request-id')).toBe('auth-session:guest');
    expect(logoutResponse.status).toBe(204);
    expect(logoutResponse.headers.get('x-request-id')).toBe('auth-logout:success');
  });

  it('normalizes malformed ids and stamps auth configuration failures', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('configuration contains a secret');
    });
    const { login } = await loadAuthRoutes();

    const response = await login.GET(
      new NextRequest('https://openmaic.example.com/api/auth/login', {
        headers: { 'x-request-id': 'invalid id' },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await response.text()).not.toContain('secret');
  });

  it('stamps callback validation and redirects', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    const { callback } = await loadAuthRoutes();
    const response = await callback.GET(
      new NextRequest('https://openmaic.example.com/api/auth/callback?state=a&state=b', {
        headers: { 'x-request-id': 'auth-callback:invalid' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('auth-callback:invalid');
  });

  it('correlates an unexpected session failure without exposing the thrown message', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    mocks.resolveApplicationSession.mockRejectedValue(new Error('password=private-secret'));
    const { session } = await loadAuthRoutes();

    const response = await session.GET(
      new NextRequest('https://openmaic.example.com/api/auth/session', {
        headers: { 'x-request-id': 'auth-session:error' },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('auth-session:error');
    expect(await response.text()).not.toContain('private-secret');
  });
});
