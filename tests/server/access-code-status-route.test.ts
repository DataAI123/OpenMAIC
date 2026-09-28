import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookieGet, set: vi.fn() }),
}));

const ACCESS_CODE = 'a'.repeat(32);

type StatusGet = () => Promise<Response>;

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
    vi.unstubAllEnvs();
    mocks.cookieGet.mockReset();
    delete process.env.ACCESS_CODE;
  });

  it('reports the channel disabled in OIDC mode without reading a credential', async () => {
    for (const [key, value] of Object.entries(OIDC_ENV)) vi.stubEnv(key, value);
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      enabled: false,
      authenticated: false,
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.cookieGet).not.toHaveBeenCalled();
  });

  it('fails closed when the auth configuration is unreadable', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({ enabled: false, authenticated: false });
  });

  it('preserves the legacy access-code status when the mode is legacy', async () => {
    process.env.ACCESS_CODE = ACCESS_CODE;
    const GET = await loadGet();

    const anonymous = await GET();
    await expect(anonymous.json()).resolves.toMatchObject({ enabled: true, authenticated: false });
    expect(anonymous.headers.get('Cache-Control')).toBeNull();
    expect(mocks.cookieGet).toHaveBeenCalled();

    const { createAccessToken } = await import('@/lib/server/access-token');
    mocks.cookieGet.mockReturnValue({ value: createAccessToken(ACCESS_CODE) });

    const authenticated = await GET();
    await expect(authenticated.json()).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
    });
  });

  it('reports the channel disabled when no access code is configured', async () => {
    const GET = await loadGet();

    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({ enabled: false, authenticated: false });
  });
});
