import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_UNAVAILABLE_ERROR_CODE,
  isAuthUnavailableError,
  isLoginRequiredError,
  isLoginRequiredFailure,
  isTenantRequiredError,
  isTenantRequiredFailure,
  loginHref,
  LOGIN_REQUIRED_ERROR_CODE,
  TENANT_REQUIRED_ERROR_CODE,
  readAuthResult,
  recoverClientAuthFailure,
  safeRelativeReturnTo,
  withoutAuthResult,
} from '@/lib/auth/client-login';

afterEach(() => vi.unstubAllGlobals());

describe('login_required detection', () => {
  it('matches only the exact 401 the gate uses', () => {
    expect(isLoginRequiredFailure(401, LOGIN_REQUIRED_ERROR_CODE)).toBe(true);
    expect(isLoginRequiredFailure(401, 'INVALID_REQUEST')).toBe(false);
    expect(isLoginRequiredFailure(403, LOGIN_REQUIRED_ERROR_CODE)).toBe(false);
    expect(isLoginRequiredFailure(503, LOGIN_REQUIRED_ERROR_CODE)).toBe(false);
    expect(isLoginRequiredFailure(401, undefined)).toBe(false);
  });

  it('recognizes the thrown form and keeps AUTH_UNAVAILABLE distinct', () => {
    expect(isLoginRequiredError(new Error(LOGIN_REQUIRED_ERROR_CODE))).toBe(true);
    expect(isLoginRequiredError(new Error(AUTH_UNAVAILABLE_ERROR_CODE))).toBe(false);
    expect(isLoginRequiredError('LOGIN_REQUIRED')).toBe(false);
    expect(isAuthUnavailableError(new Error(AUTH_UNAVAILABLE_ERROR_CODE))).toBe(true);
    expect(isAuthUnavailableError(new Error(LOGIN_REQUIRED_ERROR_CODE))).toBe(false);
  });
});

describe('tenant_required detection', () => {
  it('matches only the tenant selection refusal envelope', () => {
    expect(isTenantRequiredFailure(403, TENANT_REQUIRED_ERROR_CODE)).toBe(true);
    expect(isTenantRequiredFailure(403, 'FORBIDDEN')).toBe(false);
    expect(isTenantRequiredFailure(401, TENANT_REQUIRED_ERROR_CODE)).toBe(false);
    expect(isTenantRequiredFailure(503, TENANT_REQUIRED_ERROR_CODE)).toBe(false);
    expect(isTenantRequiredFailure(403, undefined)).toBe(false);
  });

  it('recognizes the thrown server-action form without treating other auth errors as selection', () => {
    expect(isTenantRequiredError(new Error(TENANT_REQUIRED_ERROR_CODE))).toBe(true);
    expect(isTenantRequiredError(new Error(LOGIN_REQUIRED_ERROR_CODE))).toBe(false);
    expect(isTenantRequiredError(new Error(AUTH_UNAVAILABLE_ERROR_CODE))).toBe(false);
    expect(isTenantRequiredError('TENANT_REQUIRED')).toBe(false);
  });
});

describe('client auth response recovery', () => {
  it('redirects exact login failures while preserving the current page', async () => {
    const assign = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('window', {
      location: { assign, reload, pathname: '/settings', search: '?tab=general', hash: '#tenant' },
    });

    const response = new Response(JSON.stringify({ errorCode: LOGIN_REQUIRED_ERROR_CODE }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    await expect(recoverClientAuthFailure(response)).resolves.toBe(true);
    expect(assign).toHaveBeenCalledWith(
      '/api/auth/login?returnTo=%2Fsettings%3Ftab%3Dgeneral%23tenant',
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads for tenant selection and ignores other forbidden responses', async () => {
    const assign = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('window', {
      location: { assign, reload, pathname: '/settings', search: '', hash: '' },
    });

    const tenantRequired = new Response(JSON.stringify({ errorCode: TENANT_REQUIRED_ERROR_CODE }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    await expect(recoverClientAuthFailure(tenantRequired)).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    const forbidden = new Response(JSON.stringify({ errorCode: 'FORBIDDEN' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    await expect(recoverClientAuthFailure(forbidden)).resolves.toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('ignores responses without a valid JSON error code', async () => {
    const response = new Response('unauthorized', { status: 401 });
    await expect(recoverClientAuthFailure(response)).resolves.toBe(false);
  });
});

describe('safeRelativeReturnTo', () => {
  it('keeps an in-app relative path with its query and hash', () => {
    expect(safeRelativeReturnTo('/workspace?session=7#pane')).toBe('/workspace?session=7#pane');
    expect(safeRelativeReturnTo('/')).toBe('/');
  });

  it('collapses off-site, protocol-relative and auth-process targets to home', () => {
    expect(safeRelativeReturnTo('https://evil.example.com/x')).toBe('/');
    expect(safeRelativeReturnTo('//evil.example.com/x')).toBe('/');
    expect(safeRelativeReturnTo('/api/auth/callback')).toBe('/');
    expect(safeRelativeReturnTo('/auth/login')).toBe('/');
    expect(safeRelativeReturnTo('/login')).toBe('/');
    expect(safeRelativeReturnTo('')).toBe('/');
    expect(safeRelativeReturnTo('workspace')).toBe('/');
  });

  it('rejects control characters and backslashes', () => {
    expect(safeRelativeReturnTo('/work\nspace')).toBe('/');
    expect(safeRelativeReturnTo('/work\\space')).toBe('/');
  });

  it('rejects an over-long candidate', () => {
    expect(safeRelativeReturnTo(`/${'a'.repeat(2048)}`)).toBe('/');
  });

  it('drops a stale auth outcome from the return target', () => {
    expect(safeRelativeReturnTo('/workspace?auth=denied&x=1')).toBe('/workspace?x=1');
    expect(safeRelativeReturnTo('/workspace?auth=failed')).toBe('/workspace');
  });
});

describe('loginHref', () => {
  it('encodes a safe relative return target', () => {
    expect(loginHref('/workspace?x=1')).toBe('/api/auth/login?returnTo=%2Fworkspace%3Fx%3D1');
  });

  it('falls back to home for an off-site return target', () => {
    expect(loginHref('https://evil.example.com/x')).toBe('/api/auth/login?returnTo=%2F');
  });
});

describe('auth result parameter', () => {
  it('reads only known outcomes', () => {
    expect(readAuthResult('?auth=denied')).toBe('denied');
    expect(readAuthResult('?auth=failed')).toBe('failed');
    expect(readAuthResult('?auth=unavailable')).toBe('unavailable');
    expect(readAuthResult('?auth=bogus')).toBeNull();
    expect(readAuthResult('')).toBeNull();
    expect(readAuthResult('?x=1')).toBeNull();
  });

  it('removes the outcome while preserving other parameters', () => {
    expect(withoutAuthResult('?auth=denied&x=1')).toBe('?x=1');
    expect(withoutAuthResult('?x=1&auth=denied&y=2')).toBe('?x=1&y=2');
    expect(withoutAuthResult('?auth=failed')).toBe('');
    expect(withoutAuthResult('?x=1')).toBe('?x=1');
    expect(withoutAuthResult('')).toBe('');
  });
});
