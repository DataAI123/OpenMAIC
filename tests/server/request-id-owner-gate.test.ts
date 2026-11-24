import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Request correlation (batch 28). The REAL `withRequestOwnerId` boundary runs
// against a stubbed auth config/session layer: the point under test is that the
// correlation id is minted/adopted once and echoed on EVERY exit — including
// the 401/403/503 gate rejections that never reach a handler and the 500 catch.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundaryRequest(headers: Record<string, string> = {}, method = 'POST'): Request {
  return new Request('https://openmaic.example.com/api/protected', { method, headers });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'internal-42', sessionId: 'session-1', tenantId: 'default', role },
  };
}

async function importBoundary() {
  const { withRequestOwnerId } = await import('@/lib/server/agent-runtime/with-owner');
  return withRequestOwnerId;
}

describe('owner boundary — request-id correlation (batch 28)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints a UUID and echoes it on an admitted legacy response', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ origin: 'https://openmaic.example.com' }),
      async (_ownerId, responseHeaders) =>
        Response.json({ ok: true }, { headers: responseHeaders }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  it('adopts a well-formed upstream x-request-id verbatim', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ 'x-request-id': 'trace-abc.123', origin: 'https://openmaic.example.com' }),
      async (_ownerId, responseHeaders) =>
        Response.json({ ok: true }, { headers: responseHeaders }),
    );

    expect(res.headers.get('x-request-id')).toBe('trace-abc.123');
  });

  it('replaces a malformed upstream x-request-id with a UUID', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ 'x-request-id': 'not a valid id', origin: 'https://openmaic.example.com' }),
      async (_ownerId, responseHeaders) =>
        Response.json({ ok: true }, { headers: responseHeaders }),
    );

    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  it('echoes the id on the 401 LOGIN_REQUIRED gate rejection', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (
      await importBoundary()
    )(boundaryRequest({ 'x-request-id': 'gate-401' }), async () =>
      Response.json({ unreachable: true }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe('gate-401');
  });

  it('echoes the id on the 403 FORBIDDEN gate rejection', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ 'x-request-id': 'gate-403', origin: 'https://openmaic.example.com' }),
      async () => Response.json({ unreachable: true }),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('x-request-id')).toBe('gate-403');
  });

  it('echoes the id on the 503 AUTH_UNAVAILABLE gate rejection', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (
      await importBoundary()
    )(boundaryRequest({ 'x-request-id': 'gate-503' }), async () =>
      Response.json({ unreachable: true }),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('x-request-id')).toBe('gate-503');
  });

  it('echoes the id on the 500 catch and names it in the error log', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ 'x-request-id': 'boom-500', origin: 'https://openmaic.example.com' }),
      async () => {
        throw new Error('handler exploded');
      },
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBe('boom-500');
    expect(errorSpy.mock.calls[0]?.join(' ')).toContain('requestId=boom-500');
  });

  it('reuses a caller-minted id supplied through options', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (
      await importBoundary()
    )(
      boundaryRequest({ origin: 'https://openmaic.example.com' }),
      async (_ownerId, responseHeaders) =>
        Response.json({ ok: true }, { headers: responseHeaders }),
      { requestId: 'caller-minted' },
    );

    expect(res.headers.get('x-request-id')).toBe('caller-minted');
  });
});
