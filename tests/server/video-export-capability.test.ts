import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));
import { GET } from '@/app/api/export-video/capability/route';

beforeEach(() => {
  vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000/');
  proxyFetch.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function request(requestId = 'render-cap:1') {
  return new NextRequest('http://localhost/api/export-video/capability', {
    headers: { 'x-request-id': requestId },
  });
}

describe('video export capability', () => {
  it.each([true, false])(
    'forwards accepting=%s without leaking service details',
    async (accepting) => {
      proxyFetch.mockResolvedValue(
        Response.json({ ok: true, accepting, versions: { internal: 'x' } }),
      );
      const response = await GET(request());
      expect(await response.json()).toEqual({ success: true, enabled: true, accepting });
      expect(response.headers.get('x-request-id')).toBe('render-cap:1');
      expect(proxyFetch).toHaveBeenCalledWith('http://render-service:9000/health', {
        method: 'GET',
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each([{ ok: true }, { accepting: 'false' }, null])(
    'supports older health responses: %j',
    async (body) => {
      proxyFetch.mockResolvedValue(Response.json(body));
      expect(await (await GET(request())).json()).toEqual({ success: true, enabled: true });
    },
  );

  it('keeps a healthy service enabled when its body is not JSON', async () => {
    proxyFetch.mockResolvedValue(new Response('OK'));
    expect(await (await GET(request())).json()).toEqual({ success: true, enabled: true });
  });

  it('does not probe an unconfigured service', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');
    expect(await (await GET(request())).json()).toEqual({ success: true, enabled: false });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('disables an unhealthy service', async () => {
    proxyFetch.mockResolvedValue(new Response('', { status: 503 }));
    expect(await (await GET(request())).json()).toEqual({ success: true, enabled: false });
  });

  it('disables an unreachable service with the existing three-second deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    proxyFetch.mockRejectedValue(new Error('unreachable'));
    expect(await (await GET(request('render-cap:unreachable'))).json()).toEqual({
      success: true,
      enabled: false,
    });
    expect(timeout).toHaveBeenCalledWith(3000);
    timeout.mockRestore();
  });

  it('logs an unreachable service by request id and exception type only', async () => {
    proxyFetch.mockRejectedValue(new Error('https://user:private-secret@render-service/health'));
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await GET(request('render-cap:private'));

    expect(response.headers.get('x-request-id')).toBe('render-cap:private');
    expect(infoLog).toHaveBeenCalledOnce();
    const line = infoLog.mock.calls.flat().join(' ');
    expect(line).toContain('render-cap:private');
    expect(line).toContain('Error');
    expect(line).not.toContain('private-secret');
    infoLog.mockRestore();
  });
});
