import { afterEach, describe, expect, it } from 'vitest';

import { redactProxyForLog, shouldBypassProxy } from '@/lib/server/proxy-fetch';

const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of NO_PROXY_VARS) saved[key] = process.env[key];

function setNoProxy(value: string | undefined) {
  for (const key of NO_PROXY_VARS) delete process.env[key];
  if (value !== undefined) process.env.NO_PROXY = value;
}

afterEach(() => {
  for (const key of NO_PROXY_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('shouldBypassProxy', () => {
  it('always bypasses loopback hosts, even without NO_PROXY', () => {
    setNoProxy(undefined);
    expect(shouldBypassProxy(new URL('http://localhost:8888/search'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://sub.localhost/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://127.0.0.1:3000/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://127.1.2.3/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://[::1]:8080/'))).toBe(true);
  });

  it('does not bypass ordinary hosts without NO_PROXY', () => {
    setNoProxy(undefined);
    expect(shouldBypassProxy(new URL('https://api.example.com/'))).toBe(false);
    expect(shouldBypassProxy(new URL('http://192.168.1.10:8888/'))).toBe(false);
  });

  it('matches exact hosts and subdomains from NO_PROXY', () => {
    setNoProxy('example.com,intra.corp');
    expect(shouldBypassProxy(new URL('https://example.com/'))).toBe(true);
    expect(shouldBypassProxy(new URL('https://api.example.com/'))).toBe(true);
    expect(shouldBypassProxy(new URL('https://notexample.com/'))).toBe(false);
    expect(shouldBypassProxy(new URL('http://build.intra.corp/'))).toBe(true);
  });

  it('treats a leading dot the same as a bare domain', () => {
    setNoProxy('.example.com');
    expect(shouldBypassProxy(new URL('https://example.com/'))).toBe(true);
    expect(shouldBypassProxy(new URL('https://api.example.com/'))).toBe(true);
  });

  it('honors per-entry ports, including protocol default ports', () => {
    setNoProxy('example.com:8080,secure.example.org:443');
    expect(shouldBypassProxy(new URL('http://example.com:8080/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://example.com:9090/'))).toBe(false);
    expect(shouldBypassProxy(new URL('https://secure.example.org/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://secure.example.org/'))).toBe(false);
  });

  it('bypasses everything for the * wildcard', () => {
    setNoProxy('*');
    expect(shouldBypassProxy(new URL('https://api.example.com/'))).toBe(true);
  });

  it('matches IP addresses listed in NO_PROXY', () => {
    setNoProxy('192.168.1.10');
    expect(shouldBypassProxy(new URL('http://192.168.1.10:8888/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://192.168.1.11:8888/'))).toBe(false);
  });

  it('ignores empty segments and whitespace in the list', () => {
    setNoProxy(' example.com , ,intra.corp ');
    expect(shouldBypassProxy(new URL('https://example.com/'))).toBe(true);
    expect(shouldBypassProxy(new URL('http://intra.corp/'))).toBe(true);
    expect(shouldBypassProxy(new URL('https://other.org/'))).toBe(false);
  });

  it('reads lowercase no_proxy as well', () => {
    setNoProxy(undefined);
    process.env.no_proxy = 'example.com';
    expect(shouldBypassProxy(new URL('https://example.com/'))).toBe(true);
    delete process.env.no_proxy;
  });
});

describe('redactProxyForLog', () => {
  it('strips basic-auth userinfo so the password never reaches the log', () => {
    const redacted = redactProxyForLog('http://user:p%40ss@proxy.corp:3128');
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('p%40ss');
    expect(redacted).not.toContain(':pass');
    expect(redacted).toContain('proxy.corp');
    expect(redacted).toContain('3128');
  });

  it('redacts a password-only credential', () => {
    const redacted = redactProxyForLog('http://:secret@proxy.corp:3128');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('proxy.corp');
  });

  it('leaves a credential-free proxy URL intact', () => {
    expect(redactProxyForLog('http://proxy.corp:3128/')).toBe('http://proxy.corp:3128/');
  });

  it('never echoes an unparseable raw value (it may itself be the secret)', () => {
    expect(redactProxyForLog('not a url with embedded:pw')).toBe('[redacted proxy URL]');
  });

  it('labels a missing proxy without throwing', () => {
    expect(redactProxyForLog(undefined)).toBe('none');
  });
});
