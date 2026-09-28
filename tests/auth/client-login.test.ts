import { describe, expect, it } from 'vitest';

import {
  AUTH_UNAVAILABLE_ERROR_CODE,
  isAuthUnavailableError,
  isLoginRequiredError,
  isLoginRequiredFailure,
  loginHref,
  LOGIN_REQUIRED_ERROR_CODE,
  readAuthResult,
  safeRelativeReturnTo,
  withoutAuthResult,
} from '@/lib/auth/client-login';

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
