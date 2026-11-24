import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';
import { createAccessToken } from '@/lib/server/access-token';

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

describe('OIDC middleware gates', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('admits authenticated owner-scoped APIs and keeps unreviewed APIs closed', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    const protectedResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages', {
        headers: { cookie },
      }),
    );
    expect(protectedResponse.status).toBe(200);

    const personalUsageResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/usage', {
        headers: { cookie },
      }),
    );
    expect(personalUsageResponse.status).toBe(200);

    const serverProvidersResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/server-providers', {
        headers: { cookie },
      }),
    );
    expect(serverProvidersResponse.status).toBe(200);

    const renderCapabilityResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/export-video/capability', {
        headers: { cookie },
      }),
    );
    expect(renderCapabilityResponse.status).toBe(200);

    const probeModelsResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/provider/probe-models', {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(probeModelsResponse.status).toBe(200);

    const verifyModelResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/verify-model', {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(verifyModelResponse.status).toBe(200);

    const unauthenticatedProbe = await middleware(
      new NextRequest('https://openmaic.example.com/api/provider/probe-models', { method: 'POST' }),
    );
    expect(unauthenticatedProbe.status).toBe(401);

    const unauthenticatedVerify = await middleware(
      new NextRequest('https://openmaic.example.com/api/verify-model', { method: 'POST' }),
    );
    expect(unauthenticatedVerify.status).toBe(401);

    const comfyuiWorkflowsResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/comfyui-workflows', {
        headers: { cookie },
      }),
    );
    expect(comfyuiWorkflowsResponse.status).toBe(200);

    const unreviewedResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/generate/video', {
        headers: { cookie },
      }),
    );
    expect(unreviewedResponse.status).toBe(503);

    const sharedAssetResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets/asset-1', {
        headers: { cookie },
      }),
    );
    expect(sharedAssetResponse.status).toBe(503);

    const ownedAssetRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets/asset-1/content', {
        headers: { cookie },
      }),
    );
    expect(ownedAssetRead.status).toBe(200);

    const assetUpload = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets', {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(assetUpload.status).toBe(200);

    const assetReplace = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets/asset-1/content', {
        method: 'PUT',
        headers: { cookie },
      }),
    );
    expect(assetReplace.status).toBe(503);

    const runtimeResponse = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/runtime/sessions/session-1', {
        headers: { cookie },
      }),
    );
    expect(runtimeResponse.status).toBe(200);
  });

  it('admits authenticated export-video render job APIs and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // The owner-scoped boundary (job→owner binding, no-oracle 404, fail-closed
    // 503) is enforced inside the handler; the gate only requires a session.
    const opened = [
      ['https://openmaic.example.com/api/export-video/render', 'POST'],
      ['https://openmaic.example.com/api/export-video/render/job-1', 'GET'],
      ['https://openmaic.example.com/api/export-video/render/job-1', 'DELETE'],
      ['https://openmaic.example.com/api/export-video/render/job-1/download', 'GET'],
    ] as const;
    for (const [url, method] of opened) {
      const authed = await middleware(new NextRequest(url, { method, headers: { cookie } }));
      expect(authed.status, `${method} ${url}`).toBe(200);

      const anon = await middleware(new NextRequest(url, { method }));
      expect(anon.status, `unauthenticated ${method} ${url}`).toBe(401);
    }
  });

  it('admits authenticated generate media POSTs and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Each handler self-enforces auth + per-user monthly quota; the gate admits
    // only POST on the exact modality path once a session is present.
    const opened = [
      'https://openmaic.example.com/api/generate/image',
      'https://openmaic.example.com/api/generate/video',
      'https://openmaic.example.com/api/generate/tts',
    ];
    for (const url of opened) {
      const authed = await middleware(
        new NextRequest(url, { method: 'POST', headers: { cookie } }),
      );
      expect(authed.status, `POST ${url}`).toBe(200);

      const anon = await middleware(new NextRequest(url, { method: 'POST' }));
      expect(anon.status, `unauthenticated POST ${url}`).toBe(401);
    }
  });

  it('admits authenticated classroom store/read and generation job APIs and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Handlers self-enforce owner/tenant privacy on the GETs and the per-user
    // 5-req/60s window on the POSTs (migration 0012); the gate only requires a
    // session. Anonymous never reaches the callbacks (no anonymous public read
    // option is passed).
    const opened = [
      ['https://openmaic.example.com/api/classroom', 'POST'],
      ['https://openmaic.example.com/api/classroom?id=classroom-1', 'GET'],
      ['https://openmaic.example.com/api/generate-classroom', 'POST'],
      ['https://openmaic.example.com/api/generate-classroom/job-1', 'GET'],
      // Batch 6 (accepted): classroom media bytes under media|audio only; the
      // handler enforces owner/tenant, traversal and symlink containment.
      ['https://openmaic.example.com/api/classroom-media/classroom-1/media/clip.mp4', 'GET'],
      ['https://openmaic.example.com/api/classroom-media/classroom-1/audio/track.mp3', 'GET'],
    ] as const;
    for (const [url, method] of opened) {
      const authed = await middleware(new NextRequest(url, { method, headers: { cookie } }));
      expect(authed.status, `${method} ${url}`).toBe(200);

      const anon = await middleware(new NextRequest(url, { method }));
      expect(anon.status, `unauthenticated ${method} ${url}`).toBe(401);
    }
  });

  it('admits authenticated azure-voices POST and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Batch 7 (accepted): the handler self-enforces the user:-only branch with
    // the azure_voices 5-req/60s window (migration 0004), the Azure host
    // whitelist and DNS-pinned public-only transport; the gate only requires
    // a session.
    const url = 'https://openmaic.example.com/api/azure-voices';
    const authed = await middleware(new NextRequest(url, { method: 'POST', headers: { cookie } }));
    expect(authed.status).toBe(200);

    const anon = await middleware(new NextRequest(url, { method: 'POST' }));
    expect(anon.status).toBe(401);
  });

  it('admits the authenticated parse-pdf POST and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Batch 10 (accepted): the handler self-enforces the user:-only owner
    // boundary, the parse_pdf 5-req/60s window (migration 0014), the OIDC
    // multipart/file size caps and the public-only SSRF pre-flight for a
    // client-supplied provider base URL; the gate only requires a session.
    const url = 'https://openmaic.example.com/api/parse-pdf';
    const authed = await middleware(new NextRequest(url, { method: 'POST', headers: { cookie } }));
    expect(authed.status).toBe(200);

    const anon = await middleware(new NextRequest(url, { method: 'POST' }));
    expect(anon.status).toBe(401);
  });

  it('admits the authenticated proxy-media POST and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Batch 11 (accepted): the handler self-enforces the user:-only owner
    // boundary, consumes the proxy_media 60-req/60s window (migration 0015) and
    // keeps the per-hop SSRF guard + pinned dispatcher; the gate only requires
    // a session.
    const url = 'https://openmaic.example.com/api/proxy-media';
    const authed = await middleware(new NextRequest(url, { method: 'POST', headers: { cookie } }));
    expect(authed.status).toBe(200);

    const anon = await middleware(new NextRequest(url, { method: 'POST' }));
    expect(anon.status).toBe(401);
  });

  it('admits authenticated tenant administration routes and requires login otherwise', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // Batch 14-16 (accepted): the handlers resolve the application session and
    // gate on a permission key themselves, then scope every read/write to the
    // session's tenant. The gate admits only the exact reviewed verb+path.
    // Batch 18 (accepted): GET /api/tenant is self-scoped (keyed by the session's
    // user id) and PATCH /api/tenant/{id} is owner-only and refuses any tenant
    // other than the session's own, so neither widens cross-tenant access.
    // Batch 19 (accepted): PATCH /api/tenant/members/{id} suspends/resumes one
    // membership behind `tenant.member.manage`, and POST /api/tenant/leave is the
    // self-scoped exit keyed strictly by the session user.
    const opened = [
      ['https://openmaic.example.com/api/tenant/members', 'GET'],
      ['https://openmaic.example.com/api/tenant/members/user-2', 'PUT'],
      ['https://openmaic.example.com/api/tenant/members/user-2', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/members/user-2', 'DELETE'],
      ['https://openmaic.example.com/api/tenant/audit', 'GET'],
      ['https://openmaic.example.com/api/tenant', 'GET'],
      ['https://openmaic.example.com/api/tenant/tenant-1', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/leave', 'POST'],
    ] as const;
    for (const [url, method] of opened) {
      const authed = await middleware(new NextRequest(url, { method, headers: { cookie } }));
      expect(authed.status, `${method} ${url}`).toBe(200);

      const anon = await middleware(new NextRequest(url, { method }));
      expect(anon.status, `unauthenticated ${method} ${url}`).toBe(401);
    }

    // A single-member read is not a reviewed entry: only list/audit GETs and
    // per-member PUT/DELETE are admitted.
    const memberRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/tenant/members/user-2', {
        headers: { cookie },
      }),
    );
    expect(memberRead.status).toBe(503);
  });

  it('keeps unknown child routes and unsupported methods closed', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    const cases = [
      ['https://openmaic.example.com/api/materials/admin/export', 'GET'],
      ['https://openmaic.example.com/api/agent/owner-events', 'POST'],
      ['https://openmaic.example.com/api/agent/sessions/status', 'PATCH'],
      ['https://openmaic.example.com/api/folders/members', 'DELETE'],
      ['https://openmaic.example.com/api/persistence/runtime/learners/merge', 'POST'],
      ['https://openmaic.example.com/api/persistence/documents', 'GET'],
      ['https://openmaic.example.com/api/auth/admin', 'GET'],
      // Batch 5 admitted the exact POST+GET /api/classroom, POST
      // /api/generate-classroom and GET /api/generate-classroom/{jobId}; batch 6
      // admitted only GET under classroom-media/{id}/media|audio. These
      // neighbours must stay closed.
      ['https://openmaic.example.com/api/classroom', 'PUT'],
      ['https://openmaic.example.com/api/classroom/extra', 'GET'],
      ['https://openmaic.example.com/api/classroom/extra', 'POST'],
      ['https://openmaic.example.com/api/classroom-media/classroom-1/secret/file.pdf', 'GET'],
      ['https://openmaic.example.com/api/classroom-media/classroom-1/media/clip.mp4', 'POST'],
      ['https://openmaic.example.com/api/generate-classroom', 'GET'],
      ['https://openmaic.example.com/api/generate-classroom/job-1', 'POST'],
      ['https://openmaic.example.com/api/generate-classroom/job-1/extra', 'GET'],
      ['https://openmaic.example.com/api/generate', 'POST'],
      ['https://openmaic.example.com/api/generate/image', 'GET'],
      ['https://openmaic.example.com/api/generate/image', 'PUT'],
      ['https://openmaic.example.com/api/generate/video', 'DELETE'],
      ['https://openmaic.example.com/api/generate/tts', 'GET'],
      ['https://openmaic.example.com/api/generate/image/extra', 'POST'],
      // extract-document POST is an accepted batch-4 entry; only exact POST is
      // admitted, so methods and child paths must stay closed.
      ['https://openmaic.example.com/api/extract-document', 'GET'],
      ['https://openmaic.example.com/api/extract-document/extra', 'POST'],
      ['https://openmaic.example.com/api/export-video/capability', 'POST'],
      ['https://openmaic.example.com/api/export-video/render', 'GET'],
      ['https://openmaic.example.com/api/export-video/render', 'DELETE'],
      ['https://openmaic.example.com/api/export-video/render/job-1', 'POST'],
      ['https://openmaic.example.com/api/export-video/render/job-1', 'PUT'],
      ['https://openmaic.example.com/api/export-video/render/job-1/download', 'POST'],
      ['https://openmaic.example.com/api/export-video/render/job-1/extra', 'GET'],
      ['https://openmaic.example.com/api/export-video/render/job-1/download/extra', 'GET'],
      ['https://openmaic.example.com/api/usage', 'POST'],
      ['https://openmaic.example.com/api/usage/history', 'GET'],
      // transcription POST is an accepted batch-4 entry; keep neighbours closed.
      ['https://openmaic.example.com/api/transcription', 'GET'],
      ['https://openmaic.example.com/api/transcription/extra', 'POST'],
      ['https://openmaic.example.com/api/provider/probe-models', 'GET'],
      ['https://openmaic.example.com/api/provider/probe-models', 'PUT'],
      // azure-voices POST is an accepted batch-7 entry; only exact POST is
      // admitted, so other methods must stay closed.
      ['https://openmaic.example.com/api/azure-voices', 'GET'],
      ['https://openmaic.example.com/api/verify-model', 'GET'],
      // verify-pdf-provider POST is an accepted batch-8 entry (see the reviewed
      // verifier test above); child paths must stay closed.
      ['https://openmaic.example.com/api/verify-pdf-provider/extra', 'POST'],
      // parse-pdf POST is an accepted batch-10 entry (see the test above); only
      // exact POST is admitted, so other methods and child paths stay closed.
      ['https://openmaic.example.com/api/parse-pdf', 'GET'],
      ['https://openmaic.example.com/api/parse-pdf', 'PUT'],
      ['https://openmaic.example.com/api/parse-pdf/extra', 'POST'],
      // proxy-media POST is an accepted batch-11 entry (see the test above);
      // only exact POST is admitted, so other methods and child paths stay closed.
      ['https://openmaic.example.com/api/proxy-media', 'GET'],
      ['https://openmaic.example.com/api/proxy-media', 'PUT'],
      ['https://openmaic.example.com/api/proxy-media/extra', 'POST'],
      ['https://openmaic.example.com/api/server-providers', 'POST'],
      ['https://openmaic.example.com/api/comfyui-workflows', 'POST'],
      // Tenant administration admits only GET /members, PUT|PATCH|DELETE
      // /members/{id}, GET /audit, POST /active, GET /tenant, PATCH
      // /tenant/{id} and POST /leave; every other verb and child path stays
      // shut. The reserved sibling segments — including `leave`, whose POST is
      // admitted — are excluded from the dynamic PATCH entry, so PATCH
      // /api/tenant/leave does not fall through to the /{tenantId} handler.
      ['https://openmaic.example.com/api/tenant', 'POST'],
      ['https://openmaic.example.com/api/tenant/tenant-1', 'GET'],
      ['https://openmaic.example.com/api/tenant/tenant-1', 'PUT'],
      ['https://openmaic.example.com/api/tenant/tenant-1', 'DELETE'],
      ['https://openmaic.example.com/api/tenant/tenant-1/extra', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/members', 'POST'],
      ['https://openmaic.example.com/api/tenant/members', 'PUT'],
      ['https://openmaic.example.com/api/tenant/members', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/members/user-2', 'POST'],
      ['https://openmaic.example.com/api/tenant/members/user-2/roles', 'GET'],
      ['https://openmaic.example.com/api/tenant/audit', 'POST'],
      ['https://openmaic.example.com/api/tenant/audit', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/audit/history', 'GET'],
      ['https://openmaic.example.com/api/tenant/active', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/leave', 'GET'],
      ['https://openmaic.example.com/api/tenant/leave', 'PATCH'],
      ['https://openmaic.example.com/api/tenant/leave', 'DELETE'],
      ['https://openmaic.example.com/api/tenant/leave/extra', 'POST'],
    ] as const;

    for (const [url, method] of cases) {
      const response = await middleware(new NextRequest(url, { method, headers: { cookie } }));
      expect(response.status, `${method} ${url}`).toBe(503);
    }
  });

  it('allows only the reviewed provider verifier POSTs with an app session', async () => {
    configureOidc();
    const cookie = await sessionCookie();
    // verify-pdf-provider is the accepted batch-8 entry; the handler restricts
    // AliDocMind under OIDC and self-enforces identity, rate limit and the
    // public-only endpoint policy.
    for (const pathname of [
      '/api/verify-image-provider',
      '/api/verify-video-provider',
      '/api/verify-pdf-provider',
    ]) {
      const post = await middleware(
        new NextRequest(`https://openmaic.example.com${pathname}`, {
          method: 'POST',
          headers: { cookie },
        }),
      );
      expect(post.status, `POST ${pathname}`).toBe(200);

      const get = await middleware(
        new NextRequest(`https://openmaic.example.com${pathname}`, {
          method: 'GET',
          headers: { cookie },
        }),
      );
      expect(get.status, `GET ${pathname}`).toBe(503);

      const unauthenticated = await middleware(
        new NextRequest(`https://openmaic.example.com${pathname}`, { method: 'POST' }),
      );
      expect(unauthenticated.status, `unauthenticated POST ${pathname}`).toBe(401);
    }
  });

  it('allows only narrow public GET candidates without a session', async () => {
    configureOidc();
    const publicRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages/public-stage'),
    );
    expect(publicRead.status).toBe(200);

    const publicWrite = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages/public-stage', {
        method: 'PATCH',
      }),
    );
    expect(publicWrite.status).toBe(401);

    const publicAssetRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets/asset-1/content'),
    );
    expect(publicAssetRead.status).toBe(200);

    const protectedCapabilityRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/comfyui-workflows'),
    );
    expect(protectedCapabilityRead.status).toBe(401);

    const protectedRenderCapabilityRead = await middleware(
      new NextRequest('https://openmaic.example.com/api/export-video/capability'),
    );
    expect(protectedRenderCapabilityRead.status).toBe(401);

    const assetUpload = await middleware(
      new NextRequest('https://openmaic.example.com/api/persistence/assets', {
        method: 'POST',
      }),
    );
    expect(assetUpload.status).toBe(401);

    const list = await middleware(new NextRequest('https://openmaic.example.com/api/stages'));
    expect(list.status).toBe(401);

    const personalUsage = await middleware(
      new NextRequest('https://openmaic.example.com/api/usage'),
    );
    expect(personalUsage.status).toBe(401);
  });

  it('stamps an x-request-id on edge rejections and adopts an upstream id', async () => {
    configureOidc();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    // A route the edge gate keeps closed: 503 before any handler runs.
    const closed = await middleware(
      new NextRequest('https://openmaic.example.com/api/generate/video', {
        headers: { 'x-request-id': 'edge-trace-1' },
      }),
    );
    expect(closed.status).toBe(503);
    expect(closed.headers.get('x-request-id')).toBe('edge-trace-1');

    // An admitted route without a session: 401 carries a freshly minted id.
    const loginRequired = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages'),
    );
    expect(loginRequired.status).toBe(401);
    expect(loginRequired.headers.get('x-request-id')).toMatch(uuid);
  });

  it('redirects unauthenticated pages through the OIDC login route', async () => {
    configureOidc();
    const response = await middleware(
      new NextRequest('https://openmaic.example.com/course?tab=recent', {
        headers: { 'x-request-id': 'oidc-page:login' },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('x-request-id')).toBe('oidc-page:login');
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/api/auth/login');
    expect(location.searchParams.get('returnTo')).toBe('/course?tab=recent');
  });
});

describe('OIDC mode ignores the legacy access-code channel', () => {
  afterEach(() => vi.unstubAllEnvs());

  const CODE = 'demo-code-that-is-long-enough';

  it('admits only the status probe and keeps verify closed even with a valid session', async () => {
    configureOidc();
    vi.stubEnv('ACCESS_CODE', CODE);
    const cookie = await sessionCookie();

    const status = await middleware(
      new NextRequest('https://openmaic.example.com/api/access-code/status', {
        headers: { cookie },
      }),
    );
    expect(status.status).toBe(200);

    const verify = await middleware(
      new NextRequest('https://openmaic.example.com/api/access-code/verify', {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(verify.status).toBe(503);
  });

  it('admits only the exact liveness GET/HEAD without a session', async () => {
    configureOidc();

    const live = await middleware(new NextRequest('https://openmaic.example.com/api/health/live'));
    expect(live.status).toBe(200);

    const head = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/live', { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);

    const post = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/live', { method: 'POST' }),
    );
    expect(post.status).toBe(503);
    expect(post.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);

    const nested = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/live/details'),
    );
    expect(nested.status).toBe(503);
  });

  it('admits only the exact readiness GET/HEAD without a session', async () => {
    configureOidc();

    for (const method of ['GET', 'HEAD'] as const) {
      const response = await middleware(
        new NextRequest('https://openmaic.example.com/api/health/ready', { method }),
      );
      expect(response.status, method).toBe(200);
    }

    const post = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/ready', { method: 'POST' }),
    );
    expect(post.status).toBe(503);

    const nested = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/ready/details'),
    );
    expect(nested.status).toBe(503);
  });

  it('still requires an application session for the status probe and admits no other verb', async () => {
    configureOidc();
    const cookie = await sessionCookie();

    const anonymous = await middleware(
      new NextRequest('https://openmaic.example.com/api/access-code/status'),
    );
    expect(anonymous.status).toBe(401);

    const otherVerb = await middleware(
      new NextRequest('https://openmaic.example.com/api/access-code/status', {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(otherVerb.status).toBe(503);
  });

  it('does not let a valid access cookie admit a business route', async () => {
    configureOidc();
    vi.stubEnv('ACCESS_CODE', CODE);

    const response = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages', {
        headers: { cookie: `openmaic_access=${createAccessToken(CODE)}` },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe('legacy access-code liveness gate', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows only GET and HEAD on the exact public liveness path', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');

    for (const method of ['GET', 'HEAD'] as const) {
      const response = await middleware(
        new NextRequest('https://openmaic.example.com/api/health/live', { method }),
      );
      expect(response.status, method).toBe(200);
    }

    const post = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/live', { method: 'POST' }),
    );
    expect(post.status).toBe(401);

    const nested = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/live/details'),
    );
    expect(nested.status).toBe(401);
  });

  it('allows only GET and HEAD on the exact public readiness path', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');

    for (const method of ['GET', 'HEAD'] as const) {
      const response = await middleware(
        new NextRequest('https://openmaic.example.com/api/health/ready', { method }),
      );
      expect(response.status, method).toBe(200);
    }

    const post = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/ready', { method: 'POST' }),
    );
    expect(post.status).toBe(401);

    const nested = await middleware(
      new NextRequest('https://openmaic.example.com/api/health/ready/details'),
    );
    expect(nested.status).toBe(401);
  });

  it('stamps the access-code gate rejection with a normalized request id', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const upstream = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages', {
        headers: { 'x-request-id': 'legacy-gate:denied' },
      }),
    );
    const malformed = await middleware(
      new NextRequest('https://openmaic.example.com/api/stages', {
        headers: { 'x-request-id': 'invalid id' },
      }),
    );

    expect(upstream.status).toBe(401);
    expect(upstream.headers.get('x-request-id')).toBe('legacy-gate:denied');
    expect(malformed.status).toBe(401);
    expect(malformed.headers.get('x-request-id')).toMatch(uuid);
  });

  it('stamps the disabled-workbench rejection before returning its 404', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRO_WORKBENCH_ENABLED', 'false');
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');

    const response = await middleware(
      new NextRequest('https://openmaic.example.com/workbench', {
        headers: { 'x-request-id': 'workbench:disabled' },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBe('workbench:disabled');
  });
});
