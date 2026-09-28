export type OpenMaicAuthMode = 'legacy' | 'oidc';

export interface LegacyAuthConfig {
  mode: 'legacy';
}

export interface OidcAuthConfig {
  mode: 'oidc';
  appOrigin: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSigningKey: Uint8Array;
  flowEncryptionKey: Uint8Array;
  sessionTtlSeconds: number;
  autoProvisionUsers: boolean;
  /**
   * Tenant a first-time auto-provisioned identity joins. Phase 1 hardcoded the
   * seeded `default` tenant; making it configuration keeps the join target a
   * deployment decision without granting any new authority — the tenant must
   * still exist and the membership is still created as `member`.
   */
  defaultTenant: string;
}

/** Conservative tenant identifier shape; the matching `tenants.id` is free text. */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type OpenMaicAuthConfig = LegacyAuthConfig | OidcAuthConfig;
export type AuthEnvironment = Record<string, string | undefined>;

export class AuthConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid OpenMAIC authentication configuration: ${problems.join('; ')}`);
    this.name = 'AuthConfigurationError';
  }
}

function parseSecret(
  value: string | undefined,
  name: string,
  problems: string[],
): Uint8Array | null {
  if (!value) {
    problems.push(`${name} is required in oidc mode`);
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    problems.push(`${name} must be base64url encoded`);
    return null;
  }
  if (bytes.length < 32 || bytes.toString('base64url') !== value.replace(/=+$/, '')) {
    problems.push(`${name} must encode at least 32 random bytes as base64url`);
    return null;
  }
  return new Uint8Array(bytes);
}

function parseAbsoluteUrl(value: string | undefined, name: string, problems: string[]): URL | null {
  if (!value) {
    problems.push(`${name} is required in oidc mode`);
    return null;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) throw new Error('invalid URL components');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${name} must be an absolute HTTP(S) URL`);
      return null;
    }
    return url;
  } catch {
    problems.push(`${name} must be an absolute URL without credentials or a fragment`);
    return null;
  }
}

function validateProductionHttps(
  url: URL | null,
  name: string,
  env: AuthEnvironment,
  problems: string[],
) {
  if (
    url &&
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    problems.push(`${name} may use HTTP only on localhost`);
  }
  if (
    url &&
    env.NODE_ENV === 'production' &&
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    problems.push(`${name} must use HTTPS in production`);
  }
}

export function resolveAuthConfig(env: AuthEnvironment = process.env): OpenMaicAuthConfig {
  const requestedMode = env.OPENMAIC_AUTH_MODE?.trim() || 'legacy';
  if (requestedMode === 'legacy') return { mode: 'legacy' };
  if (requestedMode !== 'oidc') {
    throw new AuthConfigurationError(['OPENMAIC_AUTH_MODE must be "legacy" or "oidc"']);
  }

  const problems: string[] = [];
  const appOriginUrl = parseAbsoluteUrl(env.APP_ORIGIN, 'APP_ORIGIN', problems);
  const issuerUrl = parseAbsoluteUrl(env.OIDC_ISSUER, 'OIDC_ISSUER', problems);
  const redirectUrl = parseAbsoluteUrl(env.OIDC_REDIRECT_URI, 'OIDC_REDIRECT_URI', problems);
  validateProductionHttps(appOriginUrl, 'APP_ORIGIN', env, problems);
  validateProductionHttps(issuerUrl, 'OIDC_ISSUER', env, problems);
  validateProductionHttps(redirectUrl, 'OIDC_REDIRECT_URI', env, problems);

  if (appOriginUrl && (appOriginUrl.pathname !== '/' || appOriginUrl.search)) {
    problems.push('APP_ORIGIN must contain only the application origin');
  }
  if (issuerUrl && (issuerUrl.search || issuerUrl.pathname === '/')) {
    problems.push('OIDC_ISSUER must identify the provider realm and contain no query');
  }
  if (redirectUrl && redirectUrl.pathname !== '/api/auth/callback') {
    problems.push('OIDC_REDIRECT_URI must use the fixed callback path /api/auth/callback');
  }
  if (redirectUrl?.search) problems.push('OIDC_REDIRECT_URI must not contain a query');
  if (appOriginUrl && redirectUrl && redirectUrl.origin !== appOriginUrl.origin) {
    problems.push('OIDC_REDIRECT_URI origin must match APP_ORIGIN');
  }

  const clientId = env.OIDC_CLIENT_ID?.trim() || '';
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim() || '';
  if (!clientId) problems.push('OIDC_CLIENT_ID is required in oidc mode');
  if (!clientSecret) problems.push('OIDC_CLIENT_SECRET is required in oidc mode');

  const sessionSigningKey = parseSecret(
    env.OPENMAIC_SESSION_SIGNING_KEY,
    'OPENMAIC_SESSION_SIGNING_KEY',
    problems,
  );
  const flowEncryptionKey = parseSecret(
    env.OPENMAIC_OIDC_FLOW_KEY,
    'OPENMAIC_OIDC_FLOW_KEY',
    problems,
  );
  if (
    sessionSigningKey &&
    flowEncryptionKey &&
    Buffer.from(sessionSigningKey).equals(Buffer.from(flowEncryptionKey))
  ) {
    problems.push('OPENMAIC_OIDC_FLOW_KEY must differ from OPENMAIC_SESSION_SIGNING_KEY');
  }
  const ttlRaw = env.SESSION_TTL_SECONDS?.trim() || '900';
  const sessionTtlSeconds = Number(ttlRaw);
  if (
    !/^\d+$/.test(ttlRaw) ||
    !Number.isSafeInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 300 ||
    sessionTtlSeconds > 3600
  ) {
    problems.push('SESSION_TTL_SECONDS must be an integer between 300 and 3600');
  }
  const autoProvisionRaw = env.OIDC_AUTO_PROVISION_USERS?.trim() || 'false';
  if (!['true', 'false'].includes(autoProvisionRaw)) {
    problems.push('OIDC_AUTO_PROVISION_USERS must be exactly "true" or "false"');
  }
  const defaultTenant = env.OIDC_DEFAULT_TENANT?.trim() || 'default';
  if (!TENANT_ID_PATTERN.test(defaultTenant)) {
    problems.push(
      'OIDC_DEFAULT_TENANT must start with an alphanumeric and contain only letters, digits, ".", "_" or "-"',
    );
  }

  if (problems.length > 0) throw new AuthConfigurationError(problems);
  return {
    mode: 'oidc',
    appOrigin: appOriginUrl!.origin,
    issuer: issuerUrl!.href,
    clientId,
    clientSecret,
    redirectUri: redirectUrl!.href,
    sessionSigningKey: sessionSigningKey!,
    flowEncryptionKey: flowEncryptionKey!,
    sessionTtlSeconds,
    autoProvisionUsers: autoProvisionRaw === 'true',
    defaultTenant,
  };
}
