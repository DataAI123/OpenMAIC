/**
 * The single client rule for `login_required`.
 *
 * Middleware and the Node owner boundary are the security boundary: they are
 * what answer `401 LOGIN_REQUIRED`, and the server re-validates `returnTo` with
 * its own allow-shape before any redirect. This module is display-and-navigate
 * only — it never decides whether a request is authorized, and it must stay
 * client-safe (no server-only imports).
 *
 * Every client surface that discovers an unauthenticated API response should
 * route through here so there is one login destination and one `returnTo`
 * shape, instead of each component inventing its own jump.
 */

export const LOGIN_REQUIRED_ERROR_CODE = 'LOGIN_REQUIRED';
export const TENANT_REQUIRED_ERROR_CODE = 'TENANT_REQUIRED';
export const AUTH_UNAVAILABLE_ERROR_CODE = 'AUTH_UNAVAILABLE';

export const LOGIN_PATH = '/api/auth/login';
export const AUTH_RESULT_PARAM = 'auth';

export type AuthResult = 'denied' | 'failed' | 'unavailable';

const AUTH_RESULTS: readonly AuthResult[] = ['denied', 'failed', 'unavailable'];

// Mirrors the server's `safeReturnTo` shape. Kept local so this module never
// imports a `lib/server/*` module; the server's copy remains authoritative.
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const BLOCKED_PATHS = ['/api/auth', '/auth', '/login'];
const RETURN_TO_ORIGIN = 'http://localhost.invalid';

/** True for the exact 401 the middleware / owner boundary uses for "sign in". */
export function isLoginRequiredFailure(status: number, errorCode?: string | null): boolean {
  return status === 401 && errorCode === LOGIN_REQUIRED_ERROR_CODE;
}

/** True for a valid session that must choose a tenant before tenant-scoped work. */
export function isTenantRequiredFailure(status: number, errorCode?: string | null): boolean {
  return status === 403 && errorCode === TENANT_REQUIRED_ERROR_CODE;
}

/**
 * True for the thrown form of the same signal. Client seams that cannot carry
 * an HTTP status (`getLearnerKey`, the workspace Server Action) reject with
 * `new Error('LOGIN_REQUIRED')`; `AUTH_UNAVAILABLE` is deliberately excluded —
 * the auth backend being down is not a "please sign in" and must not redirect.
 */
export function isLoginRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === LOGIN_REQUIRED_ERROR_CODE;
}

export function isTenantRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === TENANT_REQUIRED_ERROR_CODE;
}

export function isAuthUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === AUTH_UNAVAILABLE_ERROR_CODE;
}

/** Route exact auth failures from an API response through the shared recovery path. */
export async function recoverClientAuthFailure(response: Response): Promise<boolean> {
  let errorCode: string | null = null;
  try {
    const body = (await response.clone().json()) as { errorCode?: unknown };
    if (typeof body.errorCode === 'string') errorCode = body.errorCode;
  } catch {
    // Malformed or non-JSON failures are handled by the caller as ordinary errors.
  }

  if (isLoginRequiredFailure(response.status, errorCode)) {
    redirectToLogin();
    return true;
  }
  if (isTenantRequiredFailure(response.status, errorCode)) {
    refreshTenantSelection();
    return true;
  }
  return false;
}

/**
 * Reduce an in-app href to a same-site relative `returnTo`, or `/` when it is
 * not one. An absolute URL to another origin, a protocol-relative `//host`, a
 * control character, or an auth-process path all collapse to `/`. The auth
 * result parameter is stripped so a redirect never carries a stale outcome back
 * into the login flow.
 */
export function safeRelativeReturnTo(href: string): string {
  if (!href || href.length > 2048 || CONTROL_OR_BACKSLASH.test(href)) return '/';
  if (!href.startsWith('/') || href.startsWith('//')) return '/';

  let target: URL;
  try {
    target = new URL(href, RETURN_TO_ORIGIN);
  } catch {
    return '/';
  }
  if (target.origin !== RETURN_TO_ORIGIN || target.username || target.password) return '/';
  if (
    BLOCKED_PATHS.some(
      (blocked) => target.pathname === blocked || target.pathname.startsWith(`${blocked}/`),
    )
  ) {
    return '/';
  }

  target.searchParams.delete(AUTH_RESULT_PARAM);
  return `${target.pathname}${target.search}${target.hash}`;
}

/** The `/api/auth/login` URL that returns the visitor to `currentHref`. */
export function loginHref(currentHref: string): string {
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(safeRelativeReturnTo(currentHref))}`;
}

/** Read the post-callback outcome, or null when there is none / it is unknown. */
export function readAuthResult(search: string): AuthResult | null {
  const value = new URLSearchParams(search).get(AUTH_RESULT_PARAM);
  return AUTH_RESULTS.includes(value as AuthResult) ? (value as AuthResult) : null;
}

/**
 * The search string (leading `?`, or `''`) with the auth result removed, so the
 * outcome does not stay in the business URL after it has been shown.
 */
export function withoutAuthResult(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(AUTH_RESULT_PARAM)) return search;
  params.delete(AUTH_RESULT_PARAM);
  const next = params.toString();
  return next ? `?${next}` : '';
}

/**
 * Send the visitor to sign in and come back to where they are. No-op without a
 * browser (SSR / tests), so callers may invoke it from shared code.
 */
export function redirectToLogin(currentHref?: string): void {
  if (typeof window === 'undefined') return;
  const href =
    currentHref ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(loginHref(href));
}

/** Refresh session state so the global tenant selection gate can take over. */
export function refreshTenantSelection(): void {
  if (typeof window === 'undefined') return;
  window.location.reload();
}
