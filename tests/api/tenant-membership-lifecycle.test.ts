import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  suspendMembership: vi.fn(),
  resumeMembership: vi.fn(),
  leaveTenant: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({
  resolveAuthConfig: mocks.resolveAuthConfig,
  TENANT_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
}));

// Keep the real cookie helpers (the invalid-session assertion checks their exact
// bytes) and swap only the database-backed resolution.
vi.mock('@/lib/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/session')>();
  return { ...actual, resolveApplicationSession: mocks.resolveApplicationSession };
});

// Keep the real TenantAdminError class so the route and the wrapper share one
// identity; mock only the DB calls.
vi.mock('@/lib/server/auth/tenant-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/tenant-admin')>();
  return {
    ...actual,
    suspendMembership: mocks.suspendMembership,
    resumeMembership: mocks.resumeMembership,
    leaveTenant: mocks.leaveTenant,
  };
});

const APP_ORIGIN = 'https://openmaic.example.com';

function authenticated(role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner') {
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

function tenantRequired() {
  mocks.resolveApplicationSession.mockResolvedValue({
    status: 'tenant-required',
    userId: 'actor-1',
    sessionId: 'session-1',
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  });
}

async function patchMember(userId: string, body: unknown, headers: Record<string, string> = {}) {
  const { PATCH } = await import('@/app/api/tenant/members/[userId]/route');
  return PATCH(
    new NextRequest(`${APP_ORIGIN}/api/tenant/members/${userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never,
    { params: Promise.resolve({ userId }) },
  );
}

async function postLeave(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/tenant/leave/route');
  return POST(
    new NextRequest(`${APP_ORIGIN}/api/tenant/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('tenant membership lifecycle routes', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.suspendMembership
      .mockReset()
      .mockResolvedValue({ userId: 'subject-1', role: 'member', status: 'suspended' });
    mocks.resumeMembership
      .mockReset()
      .mockResolvedValue({ userId: 'subject-1', role: 'member', status: 'active' });
    mocks.leaveTenant
      .mockReset()
      .mockResolvedValue({ tenantId: 'default', previousRole: 'member' });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses both routes while the deployment is not OIDC', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    for (const response of [
      await patchMember('subject-1', { status: 'suspended' }),
      await postLeave({ tenantId: 'default' }),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ success: false, errorCode: 'AUTH_UNAVAILABLE' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
    expect(mocks.leaveTenant).not.toHaveBeenCalled();
  });

  it('requires login and clears a malformed session cookie', async () => {
    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'missing' });
    const missing = await postLeave({ tenantId: 'default' }, { origin: APP_ORIGIN });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      success: false,
      errorCode: 'LOGIN_REQUIRED',
      error: 'login_required',
    });

    mocks.resolveApplicationSession.mockResolvedValueOnce({ status: 'invalid' });
    const invalid = await postLeave({ tenantId: 'default' }, { origin: APP_ORIGIN });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('set-cookie')).toContain('openmaic_session=;');
    expect(mocks.leaveTenant).not.toHaveBeenCalled();
  });

  it('answers tenant-required on the admin PATCH when the session has no chosen tenant', async () => {
    tenantRequired();
    const response = await patchMember(
      'subject-1',
      { status: 'suspended' },
      { origin: APP_ORIGIN },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'TENANT_REQUIRED',
      error: 'Tenant selection required',
    });
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
  });

  it('denies member and viewer the membership PATCH without touching the store', async () => {
    for (const role of ['member', 'viewer'] as const) {
      mocks.resolveApplicationSession.mockReset();
      authenticated(role);
      const response = await patchMember(
        'subject-1',
        { status: 'suspended' },
        { origin: APP_ORIGIN },
      );
      expect(response.status, role).toBe(403);
      expect(await response.json(), role).toEqual({
        success: false,
        errorCode: 'FORBIDDEN',
        error: 'Forbidden',
      });
    }
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin on the PATCH before touching the store', async () => {
    authenticated();
    const response = await patchMember(
      'subject-1',
      { status: 'suspended' },
      { origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
  });

  it('rejects an unknown status and an empty body before the store is called', async () => {
    authenticated();
    for (const body of [{ status: 'deleted' }, { status: undefined }, {}, undefined]) {
      const response = await patchMember('subject-1', body, { origin: APP_ORIGIN });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Invalid request',
      });
    }
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
    expect(mocks.resumeMembership).not.toHaveBeenCalled();
  });

  it('suspends a membership with the session tenant, actor and role', async () => {
    authenticated('admin');
    const response = await patchMember(
      'subject-1',
      { status: 'suspended', reason: 'under review' },
      { origin: APP_ORIGIN },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.suspendMembership).toHaveBeenCalledWith({
      tenantId: 'default',
      actorUserId: 'actor-1',
      actorRole: 'admin',
      subjectUserId: 'subject-1',
      reason: 'under review',
    });
    expect(mocks.resumeMembership).not.toHaveBeenCalled();
  });

  it('resumes a membership and defaults an absent reason to null', async () => {
    authenticated();
    const response = await patchMember('subject-1', { status: 'active' }, { origin: APP_ORIGIN });
    expect(response.status).toBe(200);
    expect(mocks.resumeMembership).toHaveBeenCalledWith({
      tenantId: 'default',
      actorUserId: 'actor-1',
      actorRole: 'owner',
      subjectUserId: 'subject-1',
      reason: null,
    });
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
  });

  it.each([
    ['conflict', 409, 'CONFLICT'],
    ['not-found', 404, 'NOT_FOUND'],
    ['forbidden', 403, 'FORBIDDEN'],
    ['invalid-request', 400, 'INVALID_REQUEST'],
    ['unavailable', 503, 'INTERNAL_ERROR'],
  ] as const)('maps a %s suspension refusal onto %i %s', async (reason, status, errorCode) => {
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    authenticated();
    mocks.suspendMembership.mockRejectedValue(new TenantAdminError(reason));

    const response = await patchMember(
      'subject-1',
      { status: 'suspended' },
      { origin: APP_ORIGIN },
    );
    expect(response.status).toBe(status);
    expect((await response.json()).errorCode).toBe(errorCode);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers an unexpected store failure on the PATCH with a generic 500', async () => {
    authenticated();
    mocks.suspendMembership.mockRejectedValue(new Error('connection reset'));
    const response = await patchMember(
      'subject-1',
      { status: 'suspended' },
      { origin: APP_ORIGIN },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Internal server error',
    });
  });

  it('lets a tenant-required session leave its own tenant', async () => {
    tenantRequired();
    const response = await postLeave(
      { tenantId: 'default' },
      { origin: APP_ORIGIN, 'x-request-id': 'tenant-leave:check' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('tenant-leave:check');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      success: true,
      tenantId: 'default',
      previousRole: 'member',
    });
    // The subject is the session user, never caller input.
    expect(mocks.leaveTenant).toHaveBeenCalledWith({
      userId: 'actor-1',
      tenantId: 'default',
      reason: null,
    });
  });

  it('ignores a body userId and uses the session user', async () => {
    authenticated();
    await postLeave(
      { tenantId: 'default', userId: 'someone-else', reason: 'moving on' },
      { origin: APP_ORIGIN },
    );
    expect(mocks.leaveTenant).toHaveBeenCalledWith({
      userId: 'actor-1',
      tenantId: 'default',
      reason: 'moving on',
    });
  });

  it('rejects a malformed tenant id before touching the store', async () => {
    authenticated();
    for (const body of [{ tenantId: 'has space' }, { tenantId: '-leading' }, {}, undefined]) {
      const response = await postLeave(body, { origin: APP_ORIGIN });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Invalid request',
      });
    }
    expect(mocks.leaveTenant).not.toHaveBeenCalled();
  });

  it('requires a same-origin leave', async () => {
    authenticated();
    const response = await postLeave(
      { tenantId: 'default' },
      { origin: 'https://evil.example.com' },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, errorCode: 'INVALID_ORIGIN' });
    expect(mocks.leaveTenant).not.toHaveBeenCalled();
  });

  it('refuses a sole owner leaving with 409', async () => {
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    authenticated();
    mocks.leaveTenant.mockRejectedValue(new TenantAdminError('conflict'));

    const response = await postLeave({ tenantId: 'default' }, { origin: APP_ORIGIN });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'CONFLICT',
      error: 'Conflict',
    });
  });

  it('answers 404 when leaving a tenant the caller is not an active member of', async () => {
    const { TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    authenticated();
    mocks.leaveTenant.mockRejectedValue(new TenantAdminError('not-found'));

    const response = await postLeave({ tenantId: 'other' }, { origin: APP_ORIGIN });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'NOT_FOUND',
      error: 'Not found',
    });
  });
});
