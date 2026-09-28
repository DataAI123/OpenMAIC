import { describe, expect, it } from 'vitest';

import { AuthConfigurationError, resolveAuthConfig } from '@/lib/server/auth/config';

const signingKey = Buffer.alloc(32, 0x31).toString('base64url');
const flowKey = Buffer.alloc(32, 0x62).toString('base64url');

function oidcEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    OPENMAIC_AUTH_MODE: 'oidc',
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://openmaic.example.com',
    OIDC_ISSUER: 'https://id.example.com/realms/openmaic',
    OIDC_CLIENT_ID: 'openmaic-web',
    OIDC_CLIENT_SECRET: 'private-client-secret',
    OIDC_REDIRECT_URI: 'https://openmaic.example.com/api/auth/callback',
    OPENMAIC_SESSION_SIGNING_KEY: signingKey,
    OPENMAIC_OIDC_FLOW_KEY: flowKey,
    ...overrides,
  };
}

describe('resolveAuthConfig', () => {
  it('keeps deployments without an explicit mode on the legacy contract', () => {
    expect(resolveAuthConfig({})).toEqual({ mode: 'legacy' });
    expect(resolveAuthConfig({ OPENMAIC_AUTH_MODE: ' legacy ' })).toEqual({ mode: 'legacy' });
  });

  it('rejects unknown modes and partial OIDC configuration', () => {
    expect(() => resolveAuthConfig({ OPENMAIC_AUTH_MODE: 'disabled' })).toThrow(
      AuthConfigurationError,
    );
    expect(() => resolveAuthConfig({ OPENMAIC_AUTH_MODE: 'oidc' })).toThrow(
      /APP_ORIGIN is required/,
    );
  });

  it('resolves a complete OIDC config without echoing secret values in errors', () => {
    const config = resolveAuthConfig(oidcEnvironment());
    expect(config).toMatchObject({
      mode: 'oidc',
      appOrigin: 'https://openmaic.example.com',
      issuer: 'https://id.example.com/realms/openmaic',
      clientId: 'openmaic-web',
      redirectUri: 'https://openmaic.example.com/api/auth/callback',
      sessionTtlSeconds: 900,
      autoProvisionUsers: false,
      defaultTenant: 'default',
    });
    if (config.mode !== 'oidc') throw new Error('Expected OIDC config');
    expect(config.sessionSigningKey).toHaveLength(32);
    expect(config.flowEncryptionKey).toHaveLength(32);
    expect([...config.sessionSigningKey]).not.toEqual([...config.flowEncryptionKey]);
  });

  it('rejects redirect-origin mismatches, insecure production URLs and short keys', () => {
    expect(() =>
      resolveAuthConfig(
        oidcEnvironment({ OIDC_REDIRECT_URI: 'https://other.example.com/api/auth/callback' }),
      ),
    ).toThrow(/origin must match APP_ORIGIN/);
    expect(() =>
      resolveAuthConfig(oidcEnvironment({ APP_ORIGIN: 'http://openmaic.example.com' })),
    ).toThrow(/APP_ORIGIN must use HTTPS/);
    expect(() =>
      resolveAuthConfig(
        oidcEnvironment({ OPENMAIC_SESSION_SIGNING_KEY: Buffer.alloc(16).toString('base64url') }),
      ),
    ).toThrow(/at least 32 random bytes/);
  });

  it('rejects non-HTTP(S) issuer URLs and callback URLs with query parameters', () => {
    expect(() =>
      resolveAuthConfig(
        oidcEnvironment({
          NODE_ENV: 'development',
          OIDC_ISSUER: 'ftp://id.example.com/realms/openmaic',
        }),
      ),
    ).toThrow(/must be an absolute HTTP\(S\) URL/);
    expect(() =>
      resolveAuthConfig(
        oidcEnvironment({
          OIDC_REDIRECT_URI:
            'https://openmaic.example.com/api/auth/callback?next=https://evil.test',
        }),
      ),
    ).toThrow(/must not contain a query/);
  });

  it('bounds session lifetime and keeps flow and session keys independent', () => {
    expect(() => resolveAuthConfig(oidcEnvironment({ SESSION_TTL_SECONDS: '43200' }))).toThrow(
      /between 300 and 3600/,
    );
    expect(() =>
      resolveAuthConfig(oidcEnvironment({ OPENMAIC_OIDC_FLOW_KEY: signingKey })),
    ).toThrow(/must differ from OPENMAIC_SESSION_SIGNING_KEY/);
    expect(() => resolveAuthConfig(oidcEnvironment({ OIDC_AUTO_PROVISION_USERS: 'yes' }))).toThrow(
      /must be exactly/,
    );
  });

  it('defaults the provisioned tenant to "default" and rejects a malformed slug', () => {
    expect(resolveAuthConfig(oidcEnvironment())).toMatchObject({ defaultTenant: 'default' });
    expect(resolveAuthConfig(oidcEnvironment({ OIDC_DEFAULT_TENANT: '  ' }))).toMatchObject({
      defaultTenant: 'default',
    });
    expect(
      resolveAuthConfig(oidcEnvironment({ OIDC_DEFAULT_TENANT: 'acme-corp.1' })),
    ).toMatchObject({ defaultTenant: 'acme-corp.1' });
    for (const bad of ['-leading', 'has space', 'a'.repeat(65), 'has/slash']) {
      expect(() => resolveAuthConfig(oidcEnvironment({ OIDC_DEFAULT_TENANT: bad })), bad).toThrow(
        /OIDC_DEFAULT_TENANT/,
      );
    }
  });
});
