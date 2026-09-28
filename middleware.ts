import { NextRequest, NextResponse } from 'next/server';

import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { verifyAccessTokenEdge } from '@/lib/server/access-token-edge';
import { hasValidApplicationSessionToken } from '@/lib/server/auth/session-edge';

function isOwnerScopedOidcApi(pathname: string, method: string): boolean {
  const verb = method.toUpperCase();
  const matches = (pattern: RegExp, ...methods: string[]) =>
    methods.includes(verb) && pattern.test(pathname);

  // Keep this method-specific and route-specific. A prefix allowlist would
  // silently admit a future child handler before its owner boundary is audited.
  return (
    matches(/^\/api\/agent\/runtime$/, 'GET') ||
    matches(/^\/api\/agent\/owner-events$/, 'GET') ||
    matches(/^\/api\/agent\/skills$/, 'GET', 'POST') ||
    matches(/^\/api\/agent\/skills\/[^/]+$/, 'GET', 'DELETE') ||
    matches(/^\/api\/agent\/sessions$/, 'GET', 'POST') ||
    matches(/^\/api\/agent\/sessions\/status$/, 'GET') ||
    matches(/^\/api\/agent\/sessions\/[^/]+$/, 'GET') ||
    matches(/^\/api\/agent\/sessions\/(?!status$)[^/]+$/, 'PATCH') ||
    matches(/^\/api\/agent\/sessions\/[^/]+\/cancel$/, 'POST') ||
    matches(/^\/api\/agent\/sessions\/[^/]+\/events$/, 'GET') ||
    matches(/^\/api\/agent\/sessions\/[^/]+\/messages$/, 'POST') ||
    matches(/^\/api\/folders$/, 'GET', 'POST') ||
    matches(/^\/api\/folders\/members$/, 'POST') ||
    matches(/^\/api\/folders\/(?!members$)[^/]+$/, 'PATCH', 'DELETE') ||
    matches(/^\/api\/materials$/, 'GET', 'POST') ||
    matches(/^\/api\/materials\/[^/]+$/, 'GET') ||
    matches(/^\/api\/skills\/[^/]+$/, 'GET') ||
    matches(/^\/api\/stages$/, 'GET', 'POST') ||
    matches(/^\/api\/stages\/[^/]+$/, 'GET', 'PUT', 'PATCH', 'DELETE') ||
    matches(/^\/api\/stages\/[^/]+\/freshness$/, 'GET') ||
    matches(/^\/api\/stages\/[^/]+\/generation-complete$/, 'POST') ||
    matches(/^\/api\/stages\/[^/]+\/manifest$/, 'GET') ||
    matches(/^\/api\/stages\/[^/]+\/publish$/, 'POST') ||
    matches(/^\/api\/stages\/[^/]+\/scenes$/, 'GET') ||
    matches(/^\/api\/stages\/[^/]+\/status$/, 'GET') ||
    matches(/^\/api\/stages\/[^/]+\/unpublish$/, 'POST') ||
    matches(/^\/api\/stage-meta\/[^/]+$/, 'GET') ||
    matches(/^\/api\/comfyui-workflows$/, 'GET') ||
    matches(/^\/api\/server-providers$/, 'GET') ||
    matches(/^\/api\/export-video\/capability$/, 'GET') ||
    // Batch 12 (accepted): access-code status probe. In OIDC mode the legacy
    // access-code channel is permanently disabled, so the handler returns
    // `enabled:false, authenticated:false` and never mints or verifies a
    // credential. Admitting it lets the app-wide AccessCodeGuard read the
    // disabled state instead of falling back to its fail-closed default and
    // showing a modal no code can satisfy. Exact GET only — /access-code/verify
    // and every other access-code path stay 503.
    matches(/^\/api\/access-code\/status$/, 'GET') ||
    // Render job routes reach the handler only after an authenticated session;
    // the handler itself enforces the job→owner binding (foreign/unknown → 404,
    // store unavailable → 503), so admitting them never widens cross-tenant read.
    matches(/^\/api\/export-video\/render$/, 'POST') ||
    matches(/^\/api\/export-video\/render\/[^/]+$/, 'GET', 'DELETE') ||
    matches(/^\/api\/export-video\/render\/[^/]+\/download$/, 'GET') ||
    // Media generation is create-only (no by-id read/write) and metered inside the
    // handler by the per-user monthly quota (reserve→settle, 429/503 fail-closed),
    // so an authenticated admit is bounded per principal — never cross-tenant.
    matches(/^\/api\/generate\/image$/, 'POST') ||
    matches(/^\/api\/generate\/video$/, 'POST') ||
    matches(/^\/api\/generate\/tts$/, 'POST') ||
    // Classroom chat is stateless (the client posts full state; the handler
    // enforces the app-session owner gate and replies with SSE). Admitting
    // POST /api/chat only — other verbs and child paths stay closed.
    matches(/^\/api\/chat$/, 'POST') ||
    // Batch 13 (accepted): the Pi director chat turn and its whiteboard
    // visibility callback. /chat/pi runs behind withRequestOwnerId with the
    // per-user chat_pi 5-req/60s window (migration 0016) before any provider
    // call and stays gated by the Pi Chat feature flag. The callback is the
    // browser's answer to a query raised inside that same loop: it runs behind
    // the same owner boundary plus the persistence principal, so a logged-in
    // caller still cannot settle another principal's pending query. Exact POSTs
    // only — other verbs and child paths stay closed.
    matches(/^\/api\/chat\/pi$/, 'POST') ||
    matches(/^\/api\/chat\/pi\/whiteboard-visibility$/, 'POST') ||
    // Scene content generation and PBL v2 tutoring are stateless turn handlers
    // (client posts full state; each runs behind withRequestOwnerId with
    // viewer/cross-origin rejection). Exact POSTs only — voice/agent-profiles/
    // quiz-grade and any other child path stay closed.
    matches(/^\/api\/generate\/scene-content$/, 'POST') ||
    matches(/^\/api\/generate\/scene-actions$/, 'POST') ||
    matches(/^\/api\/generate\/scene-outlines-stream$/, 'POST') ||
    matches(/^\/api\/pbl\/v2\/(?:instructor|evaluate|open-task|simulator)$/, 'POST') ||
    matches(/^\/api\/pbl\/v2\/task\/update$/, 'POST') ||
    // Batch 3 (accepted): voice is BYOK provider ops behind the same owner
    // gate + strict public-only URL guard; quiz-grade/agent-profiles are
    // stateless LLM handlers. (chat/pi was later opened in batch 13.)
    matches(/^\/api\/generate\/voice$/, 'POST') ||
    matches(/^\/api\/quiz-grade$/, 'POST') ||
    matches(/^\/api\/generate\/agent-profiles$/, 'POST') ||
    // Batch 4 (accepted): document extraction and ASR transcription — BYOK /
    // server-provider handlers behind the same owner gate, now also carrying
    // the per-user 5-req/60s fixed window (migration 0011). Exact POSTs only.
    matches(/^\/api\/extract-document$/, 'POST') ||
    matches(/^\/api\/transcription$/, 'POST') ||
    // Batch 5 (accepted): classroom store/read and the async classroom
    // generation job. All four run behind withRequestOwnerId with no anonymous
    // public-read option, so under OIDC every admitted call is a logged-in
    // `user:` owner and the GETs' owner/tenant private checks are fully
    // enforced. The two POSTs (write + LLM pipeline kickoff) carry the
    // per-user 5-req/60s fixed window (migration 0012); the reads do not.
    // Exact verb+path entries only — other methods and child paths stay closed.
    matches(/^\/api\/classroom$/, 'POST', 'GET') ||
    matches(/^\/api\/generate-classroom$/, 'POST') ||
    matches(/^\/api\/generate-classroom\/[^/]+$/, 'GET') ||
    // Batch 6 (accepted): classroom media bytes. The handler runs behind
    // withRequestOwnerId with no anonymous public read, enforces the stored
    // classroom's owner/tenant (foreign/missing → 404), blocks path traversal
    // and symlink escapes, and serves private,no-store for user owners. Only
    // GET under the media/ and audio/ subdirectories is admitted; other
    // subdirectories, methods and the rest of the tree stay closed. Reads are
    // unthrottled by policy (page-level asset loads).
    matches(/^\/api\/classroom-media\/[^/]+\/(?:media|audio)(?:\/.*)?$/, 'GET') ||
    // Batch 7 (accepted): Azure Speech voice-list lookup. The handler runs
    // behind withRequestOwnerId with no anonymous public read, and its OIDC
    // branch already carries the full stack: azure_voices 5-req/60s fixed
    // window (migration 0004), whitelisted official Azure hosts over HTTPS,
    // DNS-pinned public-only transport with redirects refused, 16 KiB body
    // cap, and private,no-store sanitized errors. Exact POST only — other
    // methods and child paths stay closed.
    matches(/^\/api\/azure-voices$/, 'POST') ||
    // Batch 8 (accepted): PDF provider verification, completing the
    // provider-verification family (verify-model/image/video/probe-models are
    // already admitted). The OIDC branch self-enforces the user:-only boundary
    // (non-user owner -> 401), the verify_pdf_provider 5-req/60s window
    // (migration 0005), a 16 KiB body cap, HTTPS/default-port endpoint
    // normalisation with public-only DNS validation under a 5s budget, a
    // DNS-pinned verification client and sanitized no-store errors. AliDocMind
    // only inside the handler; other PDF providers stay 503 there. Exact POST
    // only — other methods and child paths remain closed.
    matches(/^\/api\/verify-pdf-provider$/, 'POST') ||
    // Batch 9 (accepted): web search. The handler runs behind
    // withRequestOwnerId with no anonymous public read (node #45), and the
    // OIDC path now also consumes the web_search 5-req/60s fixed window
    // (migration 0013) before any provider call — searches carry real
    // per-request cost. Provider selection, managed/BYOK key precedence, and
    // the SearXNG operator-only base URL stay inside the handler. (proxy-media
    // was split out of this batch and opened in batch 11, below.)
    // Exact POST only — other methods and child paths remain closed.
    matches(/^\/api\/web-search$/, 'POST') ||
    // Batch 10 (accepted): synchronous PDF parsing. The handler runs behind
    // withRequestOwnerId with no anonymous public read, caps the OIDC multipart
    // body and PDF file size, and consumes the parse_pdf 5-req/60s fixed window
    // (migration 0014) before any provider call. Client-supplied provider base
    // URLs keep the same public-only SSRF pre-flight the already-admitted
    // /api/extract-document multipart path applies over the identical extractor
    // stack. Exact POST only — other methods and child paths remain closed.
    matches(/^\/api\/parse-pdf$/, 'POST') ||
    // Batch 11 (accepted): high-frequency media proxy for same-origin asset
    // downloads. Owner-scoped, no anonymous public read, its own 60-req/60s
    // per-user window (migration 0015) is consumed before any upstream request,
    // and every hop keeps the SSRF guard + pinned dispatcher. Exact POST only —
    // the body is a caller-supplied URL, so other methods and child paths stay
    // closed.
    matches(/^\/api\/proxy-media$/, 'POST') ||
    matches(/^\/api\/provider\/probe-models$/, 'POST') ||
    matches(/^\/api\/verify-model$/, 'POST') ||
    matches(/^\/api\/verify-image-provider$/, 'POST') ||
    matches(/^\/api\/verify-video-provider$/, 'POST') ||
    matches(/^\/api\/usage$/, 'GET') ||
    matches(/^\/api\/persistence\/documents\/[^/]+$/, 'GET', 'PUT', 'DELETE') ||
    matches(/^\/api\/persistence\/documents\/[^/]+\/stage$/, 'PUT') ||
    matches(/^\/api\/persistence\/documents\/[^/]+\/scenes\/[^/]+$/, 'GET', 'PUT', 'DELETE') ||
    matches(/^\/api\/persistence\/runtime\/sessions$/, 'POST') ||
    matches(/^\/api\/persistence\/runtime\/sessions\/[^/]+$/, 'GET', 'DELETE') ||
    matches(/^\/api\/persistence\/runtime\/sessions\/[^/]+\/status$/, 'PATCH') ||
    matches(/^\/api\/persistence\/runtime\/sessions\/[^/]+\/records$/, 'GET', 'POST') ||
    matches(/^\/api\/persistence\/runtime\/stages\/[^/]+\/learners\/[^/]+\/sessions$/, 'GET') ||
    matches(/^\/api\/persistence\/runtime\/stages\/[^/]+\/learners\/[^/]+$/, 'DELETE')
  );
}

// Batch 14-16 (accepted): tenant administration. These handlers resolve the
// verified application session themselves (`withTenantPermission`) and gate on
// a permission key, then scope every read and write to the session's tenant, so
// admitting them never widens cross-tenant access. Exact verb+path entries
// only: any other verb or child path stays 503.
//
// Batch 17 (accepted): /api/tenant/active POST is the one tenant route that also
// accepts a `tenant-required` session (a valid signed session with no chosen
// tenant). It re-validates identity, origin and the target membership in the
// store, so admitting it lets a session acquire a tenant without widening any
// cross-tenant read. The edge gate still requires the signed session token.
//
// Batch 18 (accepted): GET /api/tenant lists the caller's own memberships by
// user id, and PATCH /api/tenant/{id} renames, suspends or reactivates the
// tenant the session is already acting in, behind the owner-only
// `tenant.settings.manage` key. The handler answers the same 404 for any tenant
// other than the session's own as for an unknown one, so admitting them never
// widens cross-tenant administration. The reserved sibling segments (members,
// audit, active, leave) are excluded from the dynamic entry by the lookahead.
//
// Batch 19 (accepted): PATCH /api/tenant/members/{id} suspends or resumes one
// membership behind `tenant.member.manage`, and POST /api/tenant/leave is the
// self-scoped exit that removes the caller's own membership. Neither can widen
// cross-tenant access: the first acts only in the session's tenant and answers
// not-found for a non-member, the second is keyed strictly by the session user.
function isTenantAdminApi(pathname: string, method: string): boolean {
  const verb = method.toUpperCase();
  return (
    (pathname === '/api/tenant/members' && verb === 'GET') ||
    (/^\/api\/tenant\/members\/[^/]+$/.test(pathname) &&
      (verb === 'PUT' || verb === 'PATCH' || verb === 'DELETE')) ||
    (pathname === '/api/tenant/audit' && verb === 'GET') ||
    (pathname === '/api/tenant/active' && verb === 'POST') ||
    (pathname === '/api/tenant/leave' && verb === 'POST') ||
    (pathname === '/api/tenant' && verb === 'GET') ||
    (/^\/api\/tenant\/(?!members$|members\/|audit$|active$|leave$)[^/]+$/.test(pathname) &&
      verb === 'PATCH')
  );
}

function isOidcAssetApi(pathname: string, method: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'POST' && pathname === '/api/persistence/assets') return true;
  return (
    (verb === 'GET' || verb === 'HEAD') &&
    /^\/api\/persistence\/assets\/[^/]+\/content$/.test(pathname)
  );
}

function isOidcAuthApi(pathname: string, method: string): boolean {
  const verb = method.toUpperCase();
  return (
    (pathname === '/api/auth/login' && verb === 'GET') ||
    (pathname === '/api/auth/callback' && verb === 'GET') ||
    (pathname === '/api/auth/logout' && verb === 'POST') ||
    (pathname === '/api/auth/session' && verb === 'GET')
  );
}

function isAnonymousPublicReadApi(pathname: string, method: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return (
    /^\/api\/stages\/[^/]+(?:\/(?:scenes|manifest|status))?$/.test(pathname) ||
    /^\/api\/stage-meta\/[^/]+$/.test(pathname) ||
    /^\/api\/persistence\/documents\/[^/]+(?:\/scenes\/[^/]+)?$/.test(pathname) ||
    /^\/api\/persistence\/assets\/[^/]+\/content$/.test(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  // OIDC business routes are admitted only when their handler policy has been
  // reviewed. Owner-scoped handlers recheck the database session, membership,
  // and resource policy; explicitly non-user-specific capability reads need
  // only a valid signed application session. This edge check keeps all other
  // routes closed.
  if (process.env.OPENMAIC_AUTH_MODE?.trim() === 'oidc') {
    if (pathname === '/api/health' || isOidcAuthApi(pathname, request.method)) {
      return NextResponse.next();
    }
    if (pathname.startsWith('/api/')) {
      if (
        !isOwnerScopedOidcApi(pathname, request.method) &&
        !isOidcAssetApi(pathname, request.method) &&
        !isTenantAdminApi(pathname, request.method)
      ) {
        return new NextResponse('Enterprise authorization is not enabled for this route.', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (!(await hasValidApplicationSessionToken(request.headers))) {
        if (isAnonymousPublicReadApi(pathname, request.method)) return NextResponse.next();
        return NextResponse.json(
          { success: false, errorCode: 'LOGIN_REQUIRED', error: 'login_required' },
          { status: 401, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return NextResponse.next();
    }
    if (!(await hasValidApplicationSessionToken(request.headers))) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/api/auth/login';
      loginUrl.search = '';
      loginUrl.searchParams.set('returnTo', `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyAccessTokenEdge(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
