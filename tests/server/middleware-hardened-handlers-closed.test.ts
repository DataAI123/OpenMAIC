import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';

// Handler-first phase-5 invariant: hardening an action route with the real
// `withRequestOwnerId` gate must NEVER implicitly open its edge entry. Only
// user-accepted exact verb+path entries join the middleware allowlist (chat
// #36; scene×3 + pbl×5 #37; voice/quiz-grade/agent-profiles #38); the rest
// still get 503 under an authenticated OIDC session, and each admitted
// entry's neighbours must stay closed.

const KEY = new Uint8Array(32).fill(0x36);

async function sessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ token_use: 'app_session', version: 1, sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256', typ: 'openmaic-session+jwt', kid: 'v1' })
    .setIssuer('https://openmaic.example.com')
    .setAudience('openmaic-web')
    .setSubject('internal-user-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .setJti('token-1')
    .sign(KEY);
  return `openmaic_session=${token}`;
}

function configureOidc() {
  vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_ORIGIN', 'https://openmaic.example.com');
  vi.stubEnv('OIDC_CLIENT_ID', 'openmaic-web');
  vi.stubEnv('OPENMAIC_SESSION_SIGNING_KEY', Buffer.from(KEY).toString('base64url'));
  vi.stubEnv('SESSION_TTL_SECONDS', '900');
}

// proxy-media was hardened at the handler (node #45) and opened in batch 11
// with its own 60-req/60s media window (migration 0015); chat/pi was opened in
// batch 13 with the chat_pi window (migration 0016). Every hardened action
// handler is now accepted — a future one must be added here and asserted closed
// until it is accepted alongside its neighbours.
//
// Accepted batches (node #36 chat, #37 scene×3 + pbl×5, #38 voice/quiz-grade/
// agent-profiles, #40 extract-document/transcription, #46 web-search, #batch-10
// parse-pdf, #batch-11 proxy-media, #batch-13 chat/pi): exact POSTs admitted to
// the handler, which self-enforces the owner boundary.
const ACCEPTED_POST_ENTRIES = [
  '/api/chat',
  '/api/chat/pi',
  '/api/chat/pi/whiteboard-visibility',
  '/api/quiz-grade',
  '/api/generate/voice',
  '/api/generate/agent-profiles',
  '/api/extract-document',
  '/api/transcription',
  '/api/web-search',
  '/api/parse-pdf',
  '/api/proxy-media',
  '/api/generate/scene-content',
  '/api/generate/scene-actions',
  '/api/generate/scene-outlines-stream',
  '/api/pbl/v2/instructor',
  '/api/pbl/v2/evaluate',
  '/api/pbl/v2/open-task',
  '/api/pbl/v2/simulator',
  '/api/pbl/v2/task/update',
] as const;

describe('hardened action handlers keep their edge entries fail-closed', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('admits the accepted POST entries and keeps their neighbours closed', async () => {
    configureOidc();
    const cookie = await sessionCookie();

    for (const pathname of ACCEPTED_POST_ENTRIES) {
      const authed = await middleware(
        new NextRequest(`https://openmaic.example.com${pathname}`, {
          method: 'POST',
          headers: { cookie },
        }),
      );
      expect(authed.status, `authenticated POST ${pathname}`).toBe(200);

      const anon = await middleware(
        new NextRequest(`https://openmaic.example.com${pathname}`, { method: 'POST' }),
      );
      expect(anon.status, `unauthenticated POST ${pathname}`).toBe(401);
    }

    const closedNeighbours = [
      ['https://openmaic.example.com/api/chat', 'GET'],
      ['https://openmaic.example.com/api/chat', 'PUT'],
      ['https://openmaic.example.com/api/chat/extra', 'POST'],
      ['https://openmaic.example.com/api/chat/pi', 'GET'],
      ['https://openmaic.example.com/api/chat/pi', 'PUT'],
      ['https://openmaic.example.com/api/chat/pi/extra', 'POST'],
      ['https://openmaic.example.com/api/chat/pi/whiteboard-visibility', 'GET'],
      ['https://openmaic.example.com/api/chat/pi/whiteboard-visibility/extra', 'POST'],
      ['https://openmaic.example.com/api/generate/scene-content', 'GET'],
      ['https://openmaic.example.com/api/generate/scene-content/extra', 'POST'],
      ['https://openmaic.example.com/api/pbl/v2', 'POST'],
      ['https://openmaic.example.com/api/pbl/v2/extra', 'POST'],
      ['https://openmaic.example.com/api/pbl/v2/instructor/extra', 'POST'],
      ['https://openmaic.example.com/api/pbl/v2/task', 'POST'],
      ['https://openmaic.example.com/api/pbl/v2/task/update', 'GET'],
      ['https://openmaic.example.com/api/pbl/v2/task/update/extra', 'POST'],
      ['https://openmaic.example.com/api/quiz-grade', 'GET'],
      ['https://openmaic.example.com/api/quiz-grade/extra', 'POST'],
      ['https://openmaic.example.com/api/generate/voice', 'GET'],
      ['https://openmaic.example.com/api/generate/voice/extra', 'POST'],
      ['https://openmaic.example.com/api/generate/agent-profiles/extra', 'POST'],
      ['https://openmaic.example.com/api/extract-document', 'GET'],
      ['https://openmaic.example.com/api/extract-document/extra', 'POST'],
      ['https://openmaic.example.com/api/transcription', 'GET'],
      ['https://openmaic.example.com/api/transcription/extra', 'POST'],
      ['https://openmaic.example.com/api/web-search', 'GET'],
      ['https://openmaic.example.com/api/web-search/extra', 'POST'],
      ['https://openmaic.example.com/api/parse-pdf', 'GET'],
      ['https://openmaic.example.com/api/parse-pdf', 'PUT'],
      ['https://openmaic.example.com/api/parse-pdf/extra', 'POST'],
      ['https://openmaic.example.com/api/proxy-media', 'GET'],
      ['https://openmaic.example.com/api/proxy-media', 'PUT'],
      ['https://openmaic.example.com/api/proxy-media/extra', 'POST'],
    ] as const;
    for (const [url, method] of closedNeighbours) {
      const response = await middleware(new NextRequest(url, { method, headers: { cookie } }));
      expect(response.status, `${method} ${url}`).toBe(503);
    }
  });
});
