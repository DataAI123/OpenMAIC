import { jwtVerify } from 'jose';

const SESSION_COOKIE = 'openmaic_session';
const SESSION_TYPE = 'openmaic-session+jwt';

function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

function readSessionCookie(headers: Headers): string | null {
  const raw = headers.get('cookie');
  if (!raw || raw.length > 16_384) return null;
  const matches: string[] = [];
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator > 0 && item.slice(0, separator).trim() === sessionCookieName()) {
      matches.push(item.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function decodeSigningKey(value: string | undefined): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    const unpadded = value.replace(/=+$/, '');
    const base64 = unpadded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return bytes.length >= 32 && canonical === unpadded ? bytes : null;
  } catch {
    return null;
  }
}

/** Verify the signed session envelope at the edge; Node routes still check revocation and membership. */
export async function hasValidApplicationSessionToken(headers: Headers): Promise<boolean> {
  const token = readSessionCookie(headers);
  const key = decodeSigningKey(process.env.OPENMAIC_SESSION_SIGNING_KEY);
  const issuer = process.env.APP_ORIGIN?.trim();
  const audience = process.env.OIDC_CLIENT_ID?.trim();
  const ttlRaw = process.env.SESSION_TTL_SECONDS?.trim() || '900';
  const ttl = Number(ttlRaw);
  if (
    !token ||
    !key ||
    !issuer ||
    !audience ||
    !Number.isSafeInteger(ttl) ||
    ttl < 300 ||
    ttl > 3600
  ) {
    return false;
  }

  try {
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: new URL(issuer).origin,
      audience,
      typ: SESSION_TYPE,
      maxTokenAge: ttl,
      clockTolerance: 0,
      requiredClaims: ['sub', 'sid', 'iat', 'exp', 'jti'],
    });
    return (
      protectedHeader.kid === 'v1' &&
      payload.token_use === 'app_session' &&
      payload.version === 1 &&
      typeof payload.sub === 'string' &&
      typeof payload.sid === 'string'
    );
  } catch {
    return false;
  }
}
