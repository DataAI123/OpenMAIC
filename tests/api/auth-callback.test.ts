import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  readFlowCookie: vi.fn(),
  openOidcFlowState: vi.fn(),
  clearFlowCookieHeader: vi.fn(),
  getOidcClient: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  establishIdentitySession: vi.fn(),
  IdentityAdmissionError: class extends Error {},
  sessionCookieHeader: vi.fn(),
  safeReturnTo: vi.fn(),
}));

vi.mock('openid-client', () => ({ authorizationCodeGrant: mocks.authorizationCodeGrant }));
vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/flow-state', () => ({
  clearFlowCookieHeader: mocks.clearFlowCookieHeader,
  openOidcFlowState: mocks.openOidcFlowState,
  readFlowCookie: mocks.readFlowCookie,
}));
vi.mock('@/lib/server/auth/identity', () => ({
  establishIdentitySession: mocks.establishIdentitySession,
  IdentityAdmissionError: mocks.IdentityAdmissionError,
}));
vi.mock('@/lib/server/auth/oidc-client', () => ({ getOidcClient: mocks.getOidcClient }));
vi.mock('@/lib/server/auth/return-to', () => ({ safeReturnTo: mocks.safeReturnTo }));
vi.mock('@/lib/server/auth/session', () => ({ sessionCookieHeader: mocks.sessionCookieHeader }));

const config = {
  mode: 'oidc',
  appOrigin: 'https://openmaic.example.com',
  issuer: 'https://id.example.com/realms/openmaic',
  clientId: 'openmaic-web',
  clientSecret: 'secret',
  redirectUri: 'https://openmaic.example.com/api/auth/callback',
  sessionSigningKey: new Uint8Array(32).fill(1),
  flowEncryptionKey: new Uint8Array(32).fill(2),
  sessionTtlSeconds: 900,
  autoProvisionUsers: false,
  defaultTenant: 'default',
};

function callback(url: string) {
  return new NextRequest(url);
}

describe('GET /api/auth/callback parameter validation', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue(config);
    mocks.readFlowCookie.mockReset().mockReturnValue('encrypted-flow');
    mocks.openOidcFlowState.mockReset().mockResolvedValue({
      state: 'state-value',
      nonce: 'nonce-value',
      codeVerifier: 'verifier-value',
      returnTo: '/workspace',
    });
    mocks.clearFlowCookieHeader.mockReset().mockReturnValue('flow=; Max-Age=0');
    mocks.getOidcClient.mockReset().mockResolvedValue({});
    mocks.authorizationCodeGrant.mockReset();
    mocks.establishIdentitySession.mockReset().mockResolvedValue({ token: 'app-token' });
    mocks.sessionCookieHeader.mockReset().mockReturnValue('session=app-token');
    mocks.safeReturnTo.mockReset().mockImplementation((value) => value);
  });

  it('rejects repeated state before reading a flow cookie', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback(
        'https://openmaic.example.com/api/auth/callback?state=state-value&state=attacker-state&code=code',
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_AUTH_RESPONSE' });
    expect(mocks.readFlowCookie).not.toHaveBeenCalled();
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects repeated authorization codes before token exchange', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback(
        'https://openmaic.example.com/api/auth/callback?state=state-value&code=code-a&code=code-b',
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_AUTH_RESPONSE' });
    expect(mocks.openOidcFlowState).toHaveBeenCalledOnce();
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects repeated provider errors without redirecting or exchanging a code', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback(
        'https://openmaic.example.com/api/auth/callback?state=state-value&error=access_denied&error=server_error',
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_AUTH_RESPONSE' });
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects responses that contain both an authorization code and provider error', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback(
        'https://openmaic.example.com/api/auth/callback?state=state-value&error=access_denied&code=unexpected-code',
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_AUTH_RESPONSE' });
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects an empty provider error value', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback('https://openmaic.example.com/api/auth/callback?state=state-value&error='),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_AUTH_RESPONSE' });
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('exchanges one code with the stored PKCE verifier, state, nonce and fixed callback', async () => {
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ iss: config.issuer, sub: 'external-subject', email: 'user@example.com' }),
    });
    const { GET } = await import('@/app/api/auth/callback/route');
    const response = await GET(
      callback('https://openmaic.example.com/api/auth/callback?state=state-value&code=single-code'),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://openmaic.example.com/workspace');
    const [client, callbackUri, checks] = mocks.authorizationCodeGrant.mock.calls[0]!;
    expect(client).toEqual({});
    expect(callbackUri).toBeInstanceOf(URL);
    expect((callbackUri as URL).origin + (callbackUri as URL).pathname).toBe(config.redirectUri);
    expect(callbackUri.searchParams.getAll('code')).toEqual(['single-code']);
    expect(checks).toMatchObject({
      pkceCodeVerifier: 'verifier-value',
      expectedState: 'state-value',
      expectedNonce: 'nonce-value',
      idTokenExpected: true,
    });
    expect(mocks.establishIdentitySession).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: config.issuer, subject: 'external-subject' }),
      config,
    );
    expect(response.headers.get('set-cookie')).toContain('session=app-token');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
