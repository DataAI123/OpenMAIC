import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  switchActiveTenant: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({
  resolveAuthConfig: mocks.resolveAuthConfig,
  TENANT_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
}));

// Keep the real cookie helpers (the invalid-session assertion checks their
// exact bytes) and swap only the database-backed resolution.
vi.mock('@/lib/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/session')>();
  return { ...actual, resolveApplicationSession: mocks.resolveApplicationSession };
});

// Keep the real TenantAdminError class so the route and the wrapper share one
// identity; mock only the DB call.
vi.mock('@/lib/server/auth/tenant-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/tenant-admin')>();
  return { ...actual, switchActiveTenant: mocks.switchActiveTenant };
});

const APP_ORIGIN = 'https://openmaic.example.com';

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/tenant/active/route');
  return POST(
    new NextRequest(`${APP_ORIGIN}/api/tenant/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('POST /api/tenant/active', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.switchActiveTenant.mockReset().mockResolvedValue({ tenantId: 'second' });
  });

  it('refuses while the deployment is not OIDC', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    const response = await post({ tenantId: 'second' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.switchActiveTenant).not.toHaveBeenCalled();
  });

  it('requires login and clears a malformed session cookie', async () => {
    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'missing' });
    const missing = await post({ tenantId: 'second' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      success: false,
      errorCode: 'LOGIN_REQUIRED',
      error: 'login_required',
    });

    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'invalid' });
    const invalid = await post({ tenantId: 'second' });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('set-cookie')).toContain('openmaic_session=;');
    expect(mocks.switchActiveTenant).not.toHaveBeenCalled();
  });

  it('accepts a session that has not chosen a tenant yet', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'tenant-required',
      userId: 'actor-1',
      sessionId: 'session-1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    const response = await post({ tenantId: 'second' }, { 'x-request-id': 'tenant-active:check' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('tenant-active:check');
    expect(await response.json()).toEqual({ success: true, tenantId: 'second' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.switchActiveTenant).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'actor-1',
      tenantId: 'second',
    });
  });

  it('switches an already authenticated session', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'actor-1',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
    });
    const response = await post({ tenantId: 'second' });
    expect(response.status).toBe(200);
    expect(mocks.switchActiveTenant).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'actor-1',
      tenantId: 'second',
    });
  });

  it('rejects a foreign origin before touching the store', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'actor-1',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
    });
    const response = await post({ tenantId: 'second' }, { origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.switchActiveTenant).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant id before touching the store', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'actor-1',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
    });
    for (const body of [{ tenantId: 'has space' }, { tenantId: '-leading' }, {}, undefined]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_REQUEST' });
    }
    expect(mocks.switchActiveTenant).not.toHaveBeenCalled();
  });

  it('answers 404 when the user is not an active member of the target tenant', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'tenant-required',
      userId: 'actor-1',
      sessionId: 'session-1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    mocks.switchActiveTenant.mockRejectedValue(new TenantAdminError('not-found'));
    const response = await post({ tenantId: 'second' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'NOT_FOUND',
      error: 'Not found',
    });
  });

  it('answers 503 when the session store is unavailable', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });
    const response = await post({ tenantId: 'second' });
    expect(response.status).toBe(503);
    expect(mocks.switchActiveTenant).not.toHaveBeenCalled();
  });
});
