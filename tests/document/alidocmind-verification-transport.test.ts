import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  dispatcher: { close: vi.fn().mockResolvedValue(undefined) },
  createDispatcher: vi.fn(),
  modifyConfiguration: vi.fn(),
  modifyRequest: vi.fn(),
  modifyResponse: vi.fn(),
}));

vi.mock('undici', () => ({ fetch: mocks.fetch }));
vi.mock('@/lib/server/pinned-dispatcher', () => ({
  createValidatedDispatcher: mocks.createDispatcher,
}));

import GatewayPop from '@alicloud/gateway-pop';
import Client, { $OpenApiUtil } from '@alicloud/openapi-core';
import DocMindClient, { QueryDocParserStatusRequest } from '@alicloud/docmind-api20220711';
import { createPinnedAliDocMindVerificationClient } from '@/lib/pdf/alidocmind-verification-client';

function createTestClient() {
  const client = new Client(
    new $OpenApiUtil.Config({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      endpoint: 'docmind.example',
    }),
  );
  client._spi = {
    modifyConfiguration: mocks.modifyConfiguration,
    modifyRequest: mocks.modifyRequest,
    modifyResponse: mocks.modifyResponse,
  } as never;
  mocks.modifyRequest.mockImplementation(
    async (context: { request: { protocol: string; headers: Record<string, string> } }) => {
      context.request.protocol = 'https';
      context.request.headers.host = 'docmind.example';
      context.request.headers.authorization = 'signed';
    },
  );
  mocks.modifyResponse.mockImplementation(
    async (context: { response: { deserializedBody?: unknown } }) => {
      context.response.deserializedBody = { code: 'BizIdNotExistOrResultExpired' };
    },
  );
  return createPinnedAliDocMindVerificationClient(client);
}

describe('AliDocMind verification transport', () => {
  beforeEach(() => {
    mocks.createDispatcher.mockReturnValue(mocks.dispatcher);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.dispatcher.close.mockResolvedValue(undefined);
    mocks.createDispatcher.mockReturnValue(mocks.dispatcher);
  });

  it('keeps SDK signing and sends a single request through a strict pinned dispatcher', async () => {
    mocks.fetch.mockResolvedValue(new Response('{"code":"200"}', { status: 200 }));
    const client = createTestClient();
    const result = await client.execute(
      new $OpenApiUtil.Params({
        action: 'QueryDocParserStatus',
        version: '2022-07-11',
        protocol: 'HTTPS',
        pathname: '/',
        method: 'POST',
        authType: 'AK',
        bodyType: 'json',
        reqBodyType: 'formData',
        style: 'RPC',
      }),
      new $OpenApiUtil.OpenApiRequest({ query: { Id: 'probe' } }),
      {} as never,
    );

    expect(result.body).toEqual({ code: 'BizIdNotExistOrResultExpired' });
    expect(mocks.createDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ allowLocalNetworks: false }),
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://docmind.example/?Id=probe' }),
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ authorization: 'signed' }),
      }),
    );
    expect(mocks.dispatcher.close).toHaveBeenCalledOnce();
  });

  it('uses the installed AliDocMind signing SPI without replacing its credential signature', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('{"Code":"BizIdNotExistOrResultExpired"}', { status: 200 }),
    );
    const sdk = new DocMindClient(
      new $OpenApiUtil.Config({
        accessKeyId: 'ak-test',
        accessKeySecret: 'sk-test',
        endpoint: 'docmind.example',
        signatureVersion: 'v4',
      }),
    );
    sdk._productId = 'docmind-api';
    sdk.setGatewayClient(new GatewayPop());
    const client = createPinnedAliDocMindVerificationClient(sdk);
    await client.queryDocParserStatusWithOptions(
      new QueryDocParserStatusRequest({ id: 'probe' }),
      {} as never,
    );

    const [, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toMatch(/^ACS4-HMAC-SHA256 Credential=ak-test\//);
    expect(headers.get('x-acs-action')).toBe('QueryDocParserStatus');
    expect(mocks.dispatcher.close).toHaveBeenCalledOnce();
  });

  it('rejects redirects without following them and closes the dispatcher', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    );
    const client = createTestClient();
    await expect(
      client.execute(
        new $OpenApiUtil.Params({
          action: 'QueryDocParserStatus',
          version: '2022-07-11',
          protocol: 'HTTPS',
          pathname: '/',
          method: 'POST',
          authType: 'AK',
          bodyType: 'json',
          reqBodyType: 'formData',
        }),
        new $OpenApiUtil.OpenApiRequest({ query: { Id: 'probe' } }),
        {} as never,
      ),
    ).rejects.toThrow(/redirect/);
    expect(mocks.dispatcher.close).toHaveBeenCalledOnce();
    expect(mocks.modifyResponse).not.toHaveBeenCalled();
  });

  it('rejects a response whose declared length exceeds the cap', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('x', { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } }),
    );
    const client = createTestClient();
    await expect(
      client.execute(
        new $OpenApiUtil.Params({
          action: 'QueryDocParserStatus',
          version: '2022-07-11',
          protocol: 'HTTPS',
          pathname: '/',
          method: 'POST',
          authType: 'AK',
          bodyType: 'json',
          reqBodyType: 'formData',
        }),
        new $OpenApiUtil.OpenApiRequest({ query: { Id: 'probe' } }),
        {} as never,
      ),
    ).rejects.toThrow(/exceeded its limit/);
    expect(mocks.dispatcher.close).toHaveBeenCalledOnce();
  });
});
