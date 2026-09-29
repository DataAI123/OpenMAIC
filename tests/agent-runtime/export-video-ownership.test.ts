import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  ownerId: 'user:owner-a',
  providerConfigured: true,
  proxyFetch: vi.fn(),
  assertRenderJobOwnedBy: vi.fn(),
  recordRenderJobOwner: vi.fn(),
  checkRenderSubmitLimit: vi.fn(),
  cappedStream: { stream: new ReadableStream({ start: (c) => c.close() }), exceeded: () => false },
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: async (
    _req: NextRequest,
    handler: (ownerId: string, headers: Headers) => Promise<Response>,
  ) => handler(mocks.ownerId, new Headers()),
}));
vi.mock('@/lib/server/render-service', () => ({
  resolveRenderServiceUrl: () =>
    mocks.providerConfigured ? { url: 'http://render.test' } : { error: 'not_configured' },
}));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock('@/lib/server/capped-stream', () => ({ capBodyStream: () => mocks.cappedStream }));
vi.mock('@/lib/server/client-identity', () => ({ clientIdentity: () => 'test-client' }));
vi.mock('@/lib/server/export-render-jobs', () => ({
  assertRenderJobOwnedBy: mocks.assertRenderJobOwnedBy,
  recordRenderJobOwner: mocks.recordRenderJobOwner,
  checkRenderSubmitLimit: mocks.checkRenderSubmitLimit,
  isSafeRenderJobId: (id: unknown) =>
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 256 &&
    !/[\s\x00-\x1f\x7f/\\]/.test(id),
}));

import { GET as pollGet, DELETE as pollDelete } from '@/app/api/export-video/render/[jobId]/route';
import { GET as downloadGet } from '@/app/api/export-video/render/[jobId]/download/route';
import { POST as submit } from '@/app/api/export-video/render/route';

const ctx = (jobId = 'job-1') => ({ params: Promise.resolve({ jobId }) });
const url = (jobId = 'job-1') => `http://localhost/api/export-video/render/${jobId}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providerConfigured = true;
  mocks.ownerId = 'user:owner-a';
  mocks.checkRenderSubmitLimit.mockResolvedValue({ limited: false });
});

describe('GET poll job — ownership gates the relay', () => {
  it('answers 404 for an unowned/unknown job WITHOUT touching the render service', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(false);
    const response = await pollGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('relays for an owned job', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(true);
    mocks.proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: 'rendering' }),
    });
    const response = await pollGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, state: 'rendering' });
    expect(mocks.assertRenderJobOwnedBy).toHaveBeenCalledWith('job-1', 'user:owner-a', undefined);
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed (503) without relaying when the store is unavailable', async () => {
    mocks.assertRenderJobOwnedBy.mockRejectedValue(new Error('connection reset'));
    const response = await pollGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(503);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('still answers 501 when the render service is unconfigured', async () => {
    mocks.providerConfigured = false;
    const response = await pollGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(501);
    expect(mocks.assertRenderJobOwnedBy).not.toHaveBeenCalled();
  });
});

describe('DELETE cancel job — ownership gates the relay', () => {
  it('answers 404 for an unowned job WITHOUT relaying the cancel', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(false);
    const response = await pollDelete(new NextRequest(url(), { method: 'DELETE' }), ctx());
    expect(response.status).toBe(404);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('relays the cancel for an owned job', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(true);
    mocks.proxyFetch.mockResolvedValue({ ok: true, status: 200 });
    const response = await pollDelete(new NextRequest(url(), { method: 'DELETE' }), ctx());
    expect(response.status).toBe(200);
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
  });
});

describe('GET download job — ownership gates the content (the leak path)', () => {
  it('answers 404 for an unowned job WITHOUT fetching any bytes', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(false);
    const response = await downloadGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('streams for an owned job', async () => {
    mocks.assertRenderJobOwnedBy.mockResolvedValue(true);
    mocks.proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({ start: (c) => c.close() }),
      headers: new Headers({ 'content-type': 'video/mp4' }),
    });
    const response = await downloadGet(new NextRequest(url(), { method: 'GET' }), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
  });
});

describe('POST submit — binds the job to its owner before advertising it', () => {
  function submitRequest() {
    // Any non-empty body makes `req.body` truthy so the route reaches the
    // streaming relay; the actual multipart bytes are irrelevant (capBodyStream
    // is mocked and the relayed fetch is asserted via proxyFetch).
    return new NextRequest('http://localhost/api/export-video/render', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'export-archive-placeholder',
    });
  }

  it('records the binding and returns 202 on a healthy submit', async () => {
    mocks.proxyFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ jobId: 'job-9' }),
    });
    const response = await submit(submitRequest());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, jobId: 'job-9' });
    expect(mocks.recordRenderJobOwner).toHaveBeenCalledWith('job-9', 'user:owner-a', undefined);
    // Only the submit call; no cancel on the happy path.
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels the just-created job and fails closed when the binding cannot be written', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ jobId: 'job-9' }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    mocks.recordRenderJobOwner.mockRejectedValue(new Error('db unavailable'));
    const response = await submit(submitRequest());
    expect(response.status).toBe(503);
    expect(mocks.recordRenderJobOwner).toHaveBeenCalledTimes(1);
    // Second proxyFetch call is the best-effort upstream cancel (method DELETE).
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
    const cancelCall = mocks.proxyFetch.mock.calls[1];
    expect(cancelCall[0]).toBe('http://render.test/render/job-9');
    expect((cancelCall[1] as RequestInit).method).toBe('DELETE');
  });

  it('discards an unbindable job id the service hands back', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ jobId: 'bad/id' }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const response = await submit(submitRequest());
    expect(response.status).toBe(502);
    expect(mocks.recordRenderJobOwner).not.toHaveBeenCalled();
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an over-cap submit with 429 + Retry-After BEFORE touching the render service', async () => {
    mocks.checkRenderSubmitLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 42 });
    const response = await submit(submitRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.checkRenderSubmitLimit).toHaveBeenCalledWith('user:owner-a', undefined);
    // No bytes forwarded, no binding written.
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
    expect(mocks.recordRenderJobOwner).not.toHaveBeenCalled();
  });

  it('fails closed (503) without relaying when the concurrency store is unavailable', async () => {
    mocks.checkRenderSubmitLimit.mockRejectedValue(new Error('db unavailable'));
    const response = await submit(submitRequest());
    expect(response.status).toBe(503);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
    expect(mocks.recordRenderJobOwner).not.toHaveBeenCalled();
  });

  it('skips the cap for a legacy anonymous owner and proceeds to submit', async () => {
    mocks.ownerId = 'anon:legacy';
    mocks.recordRenderJobOwner.mockResolvedValue(undefined);
    mocks.proxyFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ jobId: 'job-anon' }),
    });
    const response = await submit(submitRequest());
    expect(response.status).toBe(202);
    expect(mocks.checkRenderSubmitLimit).not.toHaveBeenCalled();
    expect(mocks.recordRenderJobOwner).toHaveBeenCalledWith('job-anon', 'anon:legacy', undefined);
  });
});
