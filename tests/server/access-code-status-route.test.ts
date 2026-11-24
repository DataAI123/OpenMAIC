import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookieGet, set: vi.fn() }),
}));

const ACCESS_CODE = 'a'.repeat(32);

type StatusGet = (request: Request) => Promise<Response>;

function statusRequest(requestId: string) {
  return new Request('https://openmaic.example.com/api/access-code/status', {
    headers: { 'x-request-id': requestId },
  });
}

/** Re-import the route so each test sees the current environment. */
async function loadGet(): Promise<StatusGet> {
  vi.resetModules();
  const { GET } = await import('@/app/api/access-code/status/route');
  return GET;
}

const OIDC_ENV = {
  OPENMAIC_AUTH_MODE: 'oidc',
  APP_ORIGIN: 'https://openmaic.example.com',
  OIDC_ISSUER: 'https://idp.example.com/realm',
  OIDC_REDIRECT_URI: 'https://openmaic.example.com/api/auth/callback',
  OIDC_CLIENT_ID: 'openmaic-web',
  OIDC_CLIENT_SECRET: 'client-secret',
  OPENMAIC_SESSION_SIGNING_KEY: Buffer.from(new Uint8Array(32).fill(0x41)).toString('base64url'),
  OPENMAIC_OIDC_FLOW_KEY: Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64url'),
} as const;

describe('GET /api/access-code/status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.cookieGet.mockReset();
    delete process.env.ACCESS_CODE;
  });

  it('reports the channel disabled in OIDC mode without reading a credential', async () => {
    for (const [key, value] of Object.entries(OIDC_ENV)) vi.stubEnv(key, value);
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const response = await GET(statusRequest('access-code-status:oidc'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      enabled: false,
      authenticated: false,
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('access-code-status:oidc');
    expect(mocks.cookieGet).not.toHaveBeenCalled();
  });

  it('fails closed when the auth configuration is unreadable', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const response = await GET(statusRequest('access-code-status:config'));

    await expect(response.json()).resolves.toMatchObject({ enabled: false, authenticated: false });
    expect(response.headers.get('x-request-id')).toBe('access-code-status:config');
  });

  it('preserves the legacy access-code status when the mode is legacy', async () => {
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const anonymous = await GET(statusRequest('access-code-status:guest'));
    await expect(anonymous.json()).resolves.toMatchObject({ enabled: true, authenticated: false });
    expect(anonymous.headers.get('Cache-Control')).toBeNull();
    expect(anonymous.headers.get('x-request-id')).toBe('access-code-status:guest');
    expect(mocks.cookieGet).toHaveBeenCalled();

    const { createAccessToken } = await import('@/lib/server/access-token');
    mocks.cookieGet.mockReturnValue({ value: createAccessToken(ACCESS_CODE) });

    const authenticated = await GET(statusRequest('access-code-status:authed'));
    await expect(authenticated.json()).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
    });
    expect(authenticated.headers.get('x-request-id')).toBe('access-code-status:authed');
  });

  it('reports the channel disabled when no access code is configured', async () => {
    const GET = await loadGet();

    const response = await GET(statusRequest('access-code-status:disabled'));

    await expect(response.json()).resolves.toMatchObject({ enabled: false, authenticated: false });
    expect(response.headers.get('x-request-id')).toBe('access-code-status:disabled');
  });

  it('correlates unexpected cookie-store failures without returning their details', async () => {
    process.env.ACCESS_CODE = ACCESS_CODE;
    mocks.cookieGet.mockImplementation(() => {
      throw new Error('private cookie-store detail');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const GET = await loadGet();

    const response = await GET(statusRequest('access-code-status:error'));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('access-code-status:error');
    expect(await response.text()).not.toContain('private cookie-store detail');
    expect(error).toHaveBeenCalled();
  });
});
