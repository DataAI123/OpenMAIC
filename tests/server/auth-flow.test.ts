import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OidcAuthConfig } from '@/lib/server/auth/config';
import {
  clearFlowCookieHeader,
  countFlowCookies,
  openOidcFlowState,
  sealOidcFlowState,
  serializeFlowCookie,
} from '@/lib/server/auth/flow-state';
import { safeReturnTo } from '@/lib/server/auth/return-to';

const config: OidcAuthConfig = {
  mode: 'oidc',
  appOrigin: 'https://openmaic.example.com',
  issuer: 'https://id.example.com/realms/openmaic',
  clientId: 'openmaic-web',
  clientSecret: 'client-secret',
  redirectUri: 'https://openmaic.example.com/api/auth/callback',
  sessionSigningKey: new Uint8Array(32).fill(0x21),
  flowEncryptionKey: new Uint8Array(32).fill(0x42),
  sessionTtlSeconds: 900,
  autoProvisionUsers: false,
  defaultTenant: 'default',
};

describe('OIDC flow state', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('encrypts browser-bound state and rejects tampering or state substitution', async () => {
    const state = 'A'.repeat(43);
    const sealed = await sealOidcFlowState(
      {
        state,
        nonce: 'nonce-value',
        codeVerifier: 'verifier-value',
        returnTo: '/workspace?tab=recent',
        issuedAt: Math.floor(Date.now() / 1000),
      },
      config,
    );
    await expect(openOidcFlowState(sealed, config, state)).resolves.toMatchObject({
      state,
      nonce: 'nonce-value',
      codeVerifier: 'verifier-value',
      returnTo: '/workspace?tab=recent',
    });
    await expect(openOidcFlowState(sealed, config, 'B'.repeat(43))).rejects.toThrow();
    // Tamper a mid-segment base64url character, not the final auth-tag
    // character: the tag's last base64url char carries unused low padding
    // bits, so flipping it can decode to identical bytes and slip past GCM.
    const mid = Math.floor(sealed.length / 2);
    const tampered =
      sealed.slice(0, mid) + (sealed[mid] === 'a' ? 'b' : 'a') + sealed.slice(mid + 1);
    await expect(openOidcFlowState(tampered, config, state)).rejects.toThrow();
  });

  it('invalidates outstanding login flows when the flow encryption key rotates', async () => {
    const state = 'C'.repeat(43);
    const sealed = await sealOidcFlowState(
      {
        state,
        nonce: 'nonce-value',
        codeVerifier: 'verifier-value',
        returnTo: '/workspace',
        issuedAt: Math.floor(Date.now() / 1000),
      },
      config,
    );
    const rotatedConfig = {
      ...config,
      flowEncryptionKey: new Uint8Array(32).fill(0x73),
    };

    await expect(openOidcFlowState(sealed, rotatedConfig, state)).rejects.toThrow();
  });

  it('uses bounded per-flow cookies with production host-only attributes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const state = 'A'.repeat(43);
    const cookie = serializeFlowCookie(state, 'encrypted-value');
    const headers = new Headers({ cookie: cookie.split(';', 1)[0] });
    expect(cookie).toContain(`__Host-openmaic_oidc_flow_${state}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(countFlowCookies(headers)).toBe(1);
    expect(clearFlowCookieHeader(state)).toContain('Max-Age=0');
  });
});

describe('safeReturnTo', () => {
  it('keeps same-origin paths and rejects external, ambiguous and recursive targets', () => {
    expect(safeReturnTo('/workspace?tab=recent', config.appOrigin)).toBe('/workspace?tab=recent');
    expect(safeReturnTo('//evil.example/path', config.appOrigin)).toBe('/');
    expect(safeReturnTo('https://evil.example/path', config.appOrigin)).toBe('/');
    expect(safeReturnTo('/api/auth/login', config.appOrigin)).toBe('/');
    expect(safeReturnTo('/\\evil.example', config.appOrigin)).toBe('/');
    expect(safeReturnTo('/workspace%0d%0aLocation:', config.appOrigin)).toBe('/');
  });
});
