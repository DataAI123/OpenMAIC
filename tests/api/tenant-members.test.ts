import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  listTenantMembers: vi.fn(),
  assignTenantRole: vi.fn(),
  revokeTenantMembership: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));

// Keep the real cookie helper (the invalid-session assertion checks its exact
// bytes) and swap only the database-backed resolution.
vi.mock('@/lib/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/session')>();
  return { ...actual, resolveApplicationSession: mocks.resolveApplicationSession };
});

// Keep the real TenantAdminError class so the route's validation throw and the
// wrapper's `instanceof` check share one identity; mock only the DB calls.
vi.mock('@/lib/server/auth/tenant-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/tenant-admin')>();
  return {
    ...actual,
    listTenantMembers: mocks.listTenantMembers,
    assignTenantRole: mocks.assignTenantRole,
    revokeTenantMembership: mocks.revokeTenantMembership,
  };
});

const APP_ORIGIN = 'https://openmaic.example.com';

function authenticated(role: 'owner' | 'admin' | 'member' | 'viewer') {
  mocks.resolveApplicationSession.mockResolvedValue({
    status: 'authenticated',
    session: {
      userId: 'actor-1',
      sessionId: 'session-1',
      tenantId: 'default',
      role,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    },
  });
}

async function listMembers(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/tenant/members/route');
  return GET(
    new NextRequest(`${APP_ORIGIN}/api/tenant/members`, { method: 'GET', headers }) as never,
  );
}

async function putMember(userId: string, body: unknown, headers: Record<string, string> = {}) {
  const { PUT } = await import('@/app/api/tenant/members/[userId]/route');
  return PUT(
    new NextRequest(`${APP_ORIGIN}/api/tenant/members/${userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never,
    { params: Promise.resolve({ userId }) },
  );
}

async function deleteMember(userId: string, body: unknown, headers: Record<string, string> = {}) {
  const { DELETE } = await import('@/app/api/tenant/members/[userId]/route');
  return DELETE(
    new NextRequest(`${APP_ORIGIN}/api/tenant/members/${userId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never,
    { params: Promise.resolve({ userId }) },
  );
}

describe('tenant administration routes', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.listTenantMembers.mockReset().mockResolvedValue([]);
    mocks.assignTenantRole.mockReset().mockResolvedValue({
      userId: 'subject-1',
      displayName: 'Subject',
      role: 'member',
      status: 'active',
      createdAt: new Date(0).toISOString(),
    });
    mocks.revokeTenantMembership
      .mockReset()
      .mockResolvedValue({ userId: 'subject-1', previousRole: 'member' });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses every tenant-admin route while the deployment is not OIDC', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    for (const response of [
      await listMembers(),
      await putMember('subject-1', { role: 'member' }),
      await deleteMember('subject-1', {}),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ success: false, errorCode: 'AUTH_UNAVAILABLE' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
    expect(mocks.assignTenantRole).not.toHaveBeenCalled();
  });

  it('refuses with 503 when the auth configuration itself is invalid', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('bad config');
    });
    const response = await listMembers();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, errorCode: 'AUTH_UNAVAILABLE' });
  });

  it('refuses with 503 when the session store is unavailable', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });
    const response = await listMembers();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
  });

  it('requires login and clears a malformed session cookie', async () => {
    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'missing' });
    const missing = await listMembers({ 'x-request-id': 'tenant-api-check:missing' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('x-request-id')).toBe('tenant-api-check:missing');
    expect(await missing.json()).toEqual({
      success: false,
      errorCode: 'LOGIN_REQUIRED',
      error: 'login_required',
    });
    expect(missing.headers.get('set-cookie')).toBeNull();

    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'invalid' });
    const invalid = await listMembers();
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('set-cookie')).toContain('openmaic_session=;');
    expect(invalid.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers tenant-required when the session has no chosen tenant', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'tenant-required',
      userId: 'actor-1',
      sessionId: 'session-1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    const response = await listMembers();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'TENANT_REQUIRED',
      error: 'Tenant selection required',
    });
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
  });

  it('denies member and viewer the member list without touching the store', async () => {
    for (const role of ['member', 'viewer'] as const) {
      mocks.resolveApplicationSession.mockReset();
      authenticated(role);
      const response = await listMembers();
      expect(response.status, role).toBe(403);
      expect(await response.json(), role).toEqual({
        success: false,
        errorCode: 'FORBIDDEN',
        error: 'Forbidden',
      });
    }
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
  });

  it('returns the session tenant members to an admin', async () => {
    authenticated('admin');
    mocks.listTenantMembers.mockResolvedValue([
      {
        userId: 'subject-1',
        displayName: 'Subject',
        role: 'member',
        status: 'active',
        createdAt: 'x',
      },
    ]);
    const response = await listMembers({ 'x-request-id': 'tenant-api-check:success' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('tenant-api-check:success');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      success: true,
      members: [
        {
          userId: 'subject-1',
          displayName: 'Subject',
          role: 'member',
          status: 'active',
          createdAt: 'x',
        },
      ],
    });
    // The tenant is the session's, never caller input.
    expect(mocks.listTenantMembers).toHaveBeenCalledWith('default');
  });

  it('denies member and viewer role assignment without touching the store', async () => {
    for (const role of ['member', 'viewer'] as const) {
      mocks.resolveApplicationSession.mockReset();
      authenticated(role);
      const response = await putMember(
        'subject-1',
        { role: 'member' },
        {
          origin: APP_ORIGIN,
        },
      );
      expect(response.status, role).toBe(403);
    }
    expect(mocks.assignTenantRole).not.toHaveBeenCalled();
  });

  it('rejects an admin write from a foreign origin', async () => {
    authenticated('admin');
    const response = await putMember(
      'subject-1',
      { role: 'member' },
      { origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.assignTenantRole).not.toHaveBeenCalled();
  });

  it('assigns a role with the session tenant, actor and role', async () => {
    authenticated('admin');
    const response = await putMember(
      'subject-1',
      { role: 'member', reason: 'onboarding' },
      { origin: APP_ORIGIN },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.assignTenantRole).toHaveBeenCalledWith({
      tenantId: 'default',
      actorUserId: 'actor-1',
      actorRole: 'admin',
      subjectUserId: 'subject-1',
      role: 'member',
      reason: 'onboarding',
    });
  });

  it('rejects an unknown role and an empty body before the store is called', async () => {
    authenticated('owner');
    const badRole = await putMember('subject-1', { role: 'superuser' }, { origin: APP_ORIGIN });
    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid request',
    });

    const noBody = await putMember('subject-1', undefined, { origin: APP_ORIGIN });
    expect(noBody.status).toBe(400);

    expect(mocks.assignTenantRole).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404, 'NOT_FOUND'],
    ['forbidden', 403, 'FORBIDDEN'],
    ['conflict', 409, 'CONFLICT'],
    ['invalid-request', 400, 'INVALID_REQUEST'],
    ['unavailable', 503, 'INTERNAL_ERROR'],
  ] as const)('maps a %s refusal onto %i %s', async (reason, status, errorCode) => {
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    authenticated('owner');
    mocks.assignTenantRole.mockRejectedValue(new TenantAdminError(reason));

    const response = await putMember('subject-1', { role: 'member' }, { origin: APP_ORIGIN });
    expect(response.status).toBe(status);
    expect((await response.json()).errorCode).toBe(errorCode);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers an unexpected store failure with a generic 500', async () => {
    authenticated('owner');
    mocks.assignTenantRole.mockRejectedValue(new Error('connection reset'));
    const response = await putMember('subject-1', { role: 'member' }, { origin: APP_ORIGIN });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Internal server error',
    });
  });

  it('revokes a membership and accepts an empty DELETE body', async () => {
    authenticated('owner');
    const response = await deleteMember('subject-1', undefined, { origin: APP_ORIGIN });
    expect(response.status).toBe(200);
    expect(mocks.revokeTenantMembership).toHaveBeenCalledWith({
      tenantId: 'default',
      actorUserId: 'actor-1',
      actorRole: 'owner',
      subjectUserId: 'subject-1',
      reason: null,
    });
  });

  it('requires a same-origin DELETE', async () => {
    authenticated('owner');
    const response = await deleteMember('subject-1', {}, { origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.revokeTenantMembership).not.toHaveBeenCalled();
  });
});
