import * as oidc from 'openid-client';

import type { OidcAuthConfig } from './config';

const DISCOVERY_CACHE_MS = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT_SECONDS = 5;

let cached: { issuer: string; expiresAt: number; promise: Promise<oidc.Configuration> } | undefined;

/** A process-local bounded single-flight cache; failed discovery is never cached. */
export function getOidcClient(config: OidcAuthConfig): Promise<oidc.Configuration> {
  const now = Date.now();
  if (cached?.issuer === config.issuer && cached.expiresAt > now) return cached.promise;

  const issuer = new URL(config.issuer);
  const allowLocalHttp =
    issuer.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname) &&
    process.env.NODE_ENV !== 'production';
  const promise = oidc.discovery(
    issuer,
    config.clientId,
    { client_secret: config.clientSecret },
    oidc.ClientSecretBasic(config.clientSecret),
    {
      timeout: DISCOVERY_TIMEOUT_SECONDS,
      execute: [
        oidc.enableNonRepudiationChecks,
        ...(allowLocalHttp ? [oidc.allowInsecureRequests] : []),
      ],
    },
  );
  cached = { issuer: config.issuer, expiresAt: now + DISCOVERY_CACHE_MS, promise };
  void promise.catch(() => {
    if (cached?.promise === promise) cached = undefined;
  });
  return promise;
}

export function resetOidcClientCacheForTests(): void {
  cached = undefined;
}
