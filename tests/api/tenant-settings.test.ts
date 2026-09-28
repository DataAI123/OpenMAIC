import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  listTenantsForUser: vi.fn(),
  renameTenant: vi.fn(),
  setTenantStatus: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({
  resolveAuthConfig: mocks.resolveAuthConfig,
  TENANT_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
}));

vi.mock('@/lib/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/session')>();
  return { ...actual, resolveApplicationSession: mocks.resolveApplicationSession };
});

// Keep the real TenantAdminError class so the routes and the wrapper share one
// identity; mock only the DB calls.
vi.mock('@/lib/server/auth/tenant-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/tenant-admin')>();
  return {
    ...actual,
    listTenantsForUser: mocks.listTenantsForUser,
    renameTenant: mocks.renameTenant,
    setTenantStatus: mocks.setTenantStatus,
  };
});

const APP_ORIGIN = 'https://openmaic.example.com';

function authenticated(role: string, tenantId = 'acme') {
  return {
    status: 'authenticated',
    session: {
      userId: 'actor-1',
      sessionId: 'session-1',
      tenantId,
      role,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    },
  };
}

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/tenant/route');
  return GET(new NextRequest(`${APP_ORIGIN}/api/tenant`, { method: 'GET', headers }));
}

async function patch(
  tenantId: string,
  body: unknown,
  headers: Record<string, string> = {},
  session: unknown = authenticated('owner'),
  pathTenantId: string = tenantId,
) {
  mocks.resolveApplicationSession.mockResolvedValue(session);
  const { PATCH } = await import('@/app/api/tenant/[tenantId]/route');
  return PATCH(
    new NextRequest(`${APP_ORIGIN}/api/tenant/${pathTenantId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ tenantId: pathTenantId }) },
  );
}

describe('GET /api/tenant', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.listTenantsForUser
      .mockReset()
      .mockResolvedValue([
        { tenantId: 'acme', slug: 'acme', name: 'Acme', status: 'active', role: 'owner' },
      ]);
    mocks.renameTenant.mockReset();
    mocks.setTenantStatus.mockReset();
  });

  it('refuses while the deployment is not OIDC', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    const response = await get();
    expect(response.status).toBe(503);
    expect(mocks.listTenantsForUser).not.toHaveBeenCalled();
  });

  it('requires login and clears a malformed session cookie', async () => {
    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'missing' });
    expect((await get()).status).toBe(401);

    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'invalid' });
    const invalid = await get();
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('set-cookie')).toContain('openmaic_session=;');
    expect(mocks.listTenantsForUser).not.toHaveBeenCalled();
  });

  it('serves the list to a session that has not chosen a tenant yet', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'tenant-required',
      userId: 'actor-1',
      sessionId: 'session-1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      tenants: [{ tenantId: 'acme', slug: 'acme', name: 'Acme', status: 'active', role: 'owner' }],
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.listTenantsForUser).toHaveBeenCalledWith('actor-1');
  });

  it('keys the query on the session user, never on request input', async () => {
    mocks.resolveApplicationSession.mockResolvedValue(authenticated('member'));
    const response = await get({ 'x-user-id': 'someone-else' });
    expect(response.status).toBe(200);
    expect(mocks.listTenantsForUser).toHaveBeenCalledWith('actor-1');
  });

  it('answers 503 when the store is unavailable', async () => {
    mocks.resolveApplicationSession.mockResolvedValue(authenticated('owner'));
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    mocks.listTenantsForUser.mockRejectedValue(new TenantAdminError('unavailable'));
    const response = await get();
    expect(response.status).toBe(503);
  });
});

describe('PATCH /api/tenant/[tenantId]', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.listTenantsForUser.mockReset();
    mocks.renameTenant.mockReset().mockResolvedValue({ tenantId: 'acme', name: 'Acme Inc' });
    mocks.setTenantStatus.mockReset().mockResolvedValue({ tenantId: 'acme', status: 'suspended' });
  });

  it('keeps tenant settings owner-only', async () => {
    for (const role of ['admin', 'member', 'viewer']) {
      const response = await patch('acme', { name: 'Acme Inc' }, {}, authenticated(role));
      expect(response.status, role).toBe(403);
      expect(await response.json(), role).toEqual({
        success: false,
        errorCode: 'FORBIDDEN',
        error: 'Forbidden',
      });
    }
    expect(mocks.renameTenant).not.toHaveBeenCalled();
    expect(mocks.setTenantStatus).not.toHaveBeenCalled();
  });

  it('answers 404 for a tenant other than the session tenant, without touching the store', async () => {
    const response = await patch(
      'other',
      { name: 'Other Inc' },
      {},
      authenticated('owner'),
      'other',
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'NOT_FOUND',
      error: 'Not found',
    });
    expect(mocks.renameTenant).not.toHaveBeenCalled();
  });

  it('rejects a malformed path tenant id before touching the store', async () => {
    const response = await patch(
      'acme',
      { name: 'Acme Inc' },
      {},
      authenticated('owner'),
      'has space',
    );
    expect(response.status).toBe(404);
    expect(mocks.renameTenant).not.toHaveBeenCalled();
  });

  it('renames the session tenant and audits the actor', async () => {
    const response = await patch('acme', { name: 'Acme Inc' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      tenant: { tenantId: 'acme', name: 'Acme Inc' },
    });
    expect(mocks.renameTenant).toHaveBeenCalledWith({
      tenantId: 'acme',
      actorUserId: 'actor-1',
      name: 'Acme Inc',
    });
    expect(mocks.setTenantStatus).not.toHaveBeenCalled();
  });

  it('suspends and reactivates the session tenant', async () => {
    const suspended = await patch('acme', { status: 'suspended' });
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual({
      success: true,
      tenant: { tenantId: 'acme', status: 'suspended' },
    });
    expect(mocks.setTenantStatus).toHaveBeenCalledWith({
      tenantId: 'acme',
      actorUserId: 'actor-1',
      status: 'suspended',
    });

    mocks.setTenantStatus.mockResolvedValue({ tenantId: 'acme', status: 'active' });
    const activated = await patch('acme', { status: 'active' });
    expect(activated.status).toBe(200);
    expect(mocks.setTenantStatus).toHaveBeenLastCalledWith({
      tenantId: 'acme',
      actorUserId: 'actor-1',
      status: 'active',
    });
  });

  it('accepts exactly one change per request', async () => {
    for (const body of [
      {},
      undefined,
      { name: 'Acme Inc', status: 'active' },
      { status: 'deleted' },
    ]) {
      const response = await patch('acme', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Invalid request',
      });
    }
    expect(mocks.renameTenant).not.toHaveBeenCalled();
    expect(mocks.setTenantStatus).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin before touching the store', async () => {
    const response = await patch(
      'acme',
      { name: 'Acme Inc' },
      { origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.renameTenant).not.toHaveBeenCalled();
  });

  it('requires login', async () => {
    const response = await patch('acme', { name: 'Acme Inc' }, {}, { status: 'missing' });
    expect(response.status).toBe(401);
    expect(mocks.renameTenant).not.toHaveBeenCalled();
  });
});
