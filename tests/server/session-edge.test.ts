import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasValidApplicationSessionToken } from '@/lib/server/auth/session-edge';

const KEY = new Uint8Array(32).fill(0x5a);

async function sessionToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ token_use: 'app_session', version: 1, sid: 'session-1', ...overrides })
    .setProtectedHeader({ alg: 'HS256', typ: 'openmaic-session+jwt', kid: 'v1' })
    .setIssuer('https://openmaic.example.com')
    .setAudience('openmaic-web')
    .setSubject('internal-user-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .setJti('token-1')
    .sign(KEY);
}

describe('edge application-session envelope', () => {
  afterEach(() => vi.unstubAllEnvs());

  function configure() {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_ORIGIN', 'https://openmaic.example.com');
    vi.stubEnv('OIDC_CLIENT_ID', 'openmaic-web');
    vi.stubEnv('OPENMAIC_SESSION_SIGNING_KEY', Buffer.from(KEY).toString('base64url'));
    vi.stubEnv('SESSION_TTL_SECONDS', '900');
  }

  it('accepts a correctly signed application session and rejects tampering', async () => {
    configure();
    const token = await sessionToken();
    await expect(
      hasValidApplicationSessionToken(new Headers({ cookie: `openmaic_session=${token}` })),
    ).resolves.toBe(true);
    const signatureStart = token.lastIndexOf('.') + 1;
    const tamperIndex = signatureStart + Math.floor((token.length - signatureStart) / 2);
    const tampered =
      token.slice(0, tamperIndex) +
      (token[tamperIndex] === 'a' ? 'b' : 'a') +
      token.slice(tamperIndex + 1);
    await expect(
      hasValidApplicationSessionToken(new Headers({ cookie: `openmaic_session=${tampered}` })),
    ).resolves.toBe(false);
  });

  it('rejects duplicate cookies, wrong token type, and invalid key configuration', async () => {
    configure();
    const token = await sessionToken();
    await expect(
      hasValidApplicationSessionToken(
        new Headers({ cookie: `openmaic_session=${token}; openmaic_session=${token}` }),
      ),
    ).resolves.toBe(false);

    const wrongType = await new SignJWT({ token_use: 'id_token', version: 1, sid: 'session-1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'id+jwt', kid: 'v1' })
      .setIssuer('https://openmaic.example.com')
      .setAudience('openmaic-web')
      .setSubject('internal-user-1')
      .setIssuedAt()
      .setExpirationTime('15m')
      .setJti('token-2')
      .sign(KEY);
    await expect(
      hasValidApplicationSessionToken(new Headers({ cookie: `openmaic_session=${wrongType}` })),
    ).resolves.toBe(false);

    vi.stubEnv('OPENMAIC_SESSION_SIGNING_KEY', 'weak');
    await expect(
      hasValidApplicationSessionToken(new Headers({ cookie: `openmaic_session=${token}` })),
    ).resolves.toBe(false);
  });
});
