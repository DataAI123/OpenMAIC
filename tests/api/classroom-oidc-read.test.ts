import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  readClassroom: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: vi.fn(),
  ClassroomAlreadyExistsError: class extends Error {},
  CLASSROOM_ID_MAX_ATTEMPTS: 5,
  generateClassroomId: vi.fn(),
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  persistClassroom: vi.fn(),
  readClassroom: mocks.readClassroom,
}));

function getClassroom(id = 'classroom-1') {
  return new NextRequest(`https://openmaic.example/api/classroom?id=${id}`);
}

describe('GET /api/classroom OIDC read boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
    mocks.readClassroom.mockReset().mockResolvedValue({
      id: 'classroom-1',
      ownerId: 'user:alice',
      tenantId: 'default',
      stage: { id: 'classroom-1', name: 'Test' },
      scenes: [],
      createdAt: '2026-09-24T00:00:00.000Z',
    });
  });

  it('serves the owner’s classroom with private no-store caching', async () => {
    const { GET } = await import('@/app/api/classroom/route');
    const response = await GET(getClassroom());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('hides foreign-owner and foreign-tenant classrooms with the same 404', async () => {
    const { GET } = await import('@/app/api/classroom/route');
    mocks.readClassroom.mockResolvedValueOnce({
      id: 'classroom-1',
      ownerId: 'user:bob',
      tenantId: 'default',
      stage: {},
      scenes: [],
    });
    const foreignOwner = await GET(getClassroom());
    const foreignOwnerBody = await foreignOwner.json();

    mocks.readClassroom.mockResolvedValueOnce({
      id: 'classroom-1',
      ownerId: 'user:alice',
      tenantId: 'other-tenant',
      stage: {},
      scenes: [],
    });
    const foreignTenant = await GET(getClassroom());
    const foreignTenantBody = await foreignTenant.json();

    expect(foreignOwner.status).toBe(404);
    expect(foreignTenant.status).toBe(404);
    expect(foreignOwnerBody).toEqual(foreignTenantBody);
    expect(foreignTenant.headers.get('cache-control')).toBe('private, no-store');
  });

  it('does not allow legacy or unowned classroom data into the OIDC owner scope', async () => {
    const { GET } = await import('@/app/api/classroom/route');
    mocks.readClassroom.mockResolvedValueOnce({
      id: 'classroom-1',
      stage: {},
      scenes: [],
    });

    const response = await GET(getClassroom());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('classroom-1');
  });

  it('preserves legacy public-by-id reads and propagates the legacy cookie', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_request, handler) =>
      handler('anon:legacy', new Headers({ 'Set-Cookie': 'openmaic_access=legacy; Path=/' })),
    );
    mocks.readClassroom.mockResolvedValueOnce({
      id: 'classroom-1',
      ownerId: 'anon:someone-else',
      stage: { name: 'Shared legacy classroom' },
      scenes: [],
    });
    const { GET } = await import('@/app/api/classroom/route');

    const response = await GET(getClassroom());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('openmaic_access=legacy');
    expect(body.classroom.stage.name).toBe('Shared legacy classroom');
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('returns the identity boundary failure without reading a classroom', async () => {
    mocks.withRequestOwnerId.mockResolvedValueOnce(
      Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 }),
    );
    const { GET } = await import('@/app/api/classroom/route');

    const response = await GET(getClassroom());
    expect(response.status).toBe(401);
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });
});
