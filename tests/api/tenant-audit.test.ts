import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  listTenantRoleAudit: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));

vi.mock('@/lib/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/session')>();
  return { ...actual, resolveApplicationSession: mocks.resolveApplicationSession };
});

vi.mock('@/lib/server/auth/tenant-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/auth/tenant-admin')>();
  return { ...actual, listTenantRoleAudit: mocks.listTenantRoleAudit };
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

async function listAudit(query = '') {
  const { GET } = await import('@/app/api/tenant/audit/route');
  return GET(new NextRequest(`${APP_ORIGIN}/api/tenant/audit${query}`, { method: 'GET' }) as never);
}

describe('GET /api/tenant/audit', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc', appOrigin: APP_ORIGIN });
    mocks.resolveApplicationSession.mockReset();
    mocks.listTenantRoleAudit.mockReset().mockResolvedValue([]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('denies member and viewer the audit trail without touching the store', async () => {
    for (const role of ['member', 'viewer'] as const) {
      mocks.resolveApplicationSession.mockReset();
      authenticated(role);
      const response = await listAudit();
      expect(response.status, role).toBe(403);
      expect(await response.json(), role).toEqual({
        success: false,
        errorCode: 'FORBIDDEN',
        error: 'Forbidden',
      });
    }
    expect(mocks.listTenantRoleAudit).not.toHaveBeenCalled();
  });

  it('returns the session tenant audit rows to an admin', async () => {
    authenticated('admin');
    mocks.listTenantRoleAudit.mockResolvedValue([
      {
        id: 'audit-1',
        actorUserId: 'actor-1',
        subjectUserId: 'subject-1',
        action: 'grant',
        previousRole: null,
        newRole: 'member',
        source: 'api',
        reason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const response = await listAudit();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      success: true,
      entries: [
        {
          id: 'audit-1',
          actorUserId: 'actor-1',
          subjectUserId: 'subject-1',
          action: 'grant',
          previousRole: null,
          newRole: 'member',
          source: 'api',
          reason: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(mocks.listTenantRoleAudit).toHaveBeenCalledWith('default', undefined);
  });

  it('passes the requested bounded limit through to the store', async () => {
    authenticated('owner');
    await listAudit('?limit=10');
    expect(mocks.listTenantRoleAudit).toHaveBeenCalledWith('default', 10);
  });

  it('requires login before any audit read', async () => {
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'missing' });
    const response = await listAudit();
    expect(response.status).toBe(401);
    expect(mocks.listTenantRoleAudit).not.toHaveBeenCalled();
  });

  it('answers an unexpected store failure with a generic 500', async () => {
    authenticated('owner');
    mocks.listTenantRoleAudit.mockRejectedValue(new Error('connection reset'));
    const response = await listAudit();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Internal server error',
    });
  });
});
