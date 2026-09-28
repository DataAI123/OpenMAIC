import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  createValidatedDispatcher: vi.fn(),
  fetchWithRedirectValidation: vi.fn(),
  dispatcherClose: vi.fn(),
}));

vi.mock('undici', () => ({ fetch: mocks.undiciFetch }));
vi.mock('@/lib/server/pinned-dispatcher', () => ({
  createValidatedDispatcher: mocks.createValidatedDispatcher,
}));
vi.mock('@/lib/server/fetch-with-redirect-validation', () => ({
  fetchWithRedirectValidation: mocks.fetchWithRedirectValidation,
}));

describe('provider verification transport', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses a DNS-pinned dispatcher with the selected address policy and closes it', async () => {
    const dispatcher = { close: mocks.dispatcherClose };
    mocks.createValidatedDispatcher.mockReturnValue(dispatcher);
    mocks.fetchWithRedirectValidation.mockImplementation(async (input, init, options) =>
      options.fetchImpl(input, init),
    );
    mocks.undiciFetch.mockResolvedValue(new Response('ok'));

    const { createProviderVerificationTransport } =
      await import('@/lib/server/provider-verification-transport');
    const transport = createProviderVerificationTransport({ allowLocalNetworks: false });
    await expect(transport.fetch('https://provider.example.test')).resolves.toMatchObject({
      status: 200,
    });
    await transport.close();

    expect(mocks.createValidatedDispatcher).toHaveBeenCalledWith({
      allowLocalNetworks: false,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
      connectTimeout: 5000,
    });
    expect(mocks.fetchWithRedirectValidation).toHaveBeenCalledWith(
      'https://provider.example.test',
      undefined,
      expect.objectContaining({ allowLocalNetworks: false, dispatcher }),
    );
    expect(mocks.dispatcherClose).toHaveBeenCalledOnce();
  });

  it('can reject redirects while preserving the pinned transport and response cap', async () => {
    const dispatcher = { close: mocks.dispatcherClose };
    mocks.createValidatedDispatcher.mockReturnValue(dispatcher);
    mocks.undiciFetch.mockResolvedValue(new Response(null, { status: 302 }));

    const { createProviderVerificationTransport } =
      await import('@/lib/server/provider-verification-transport');
    const transport = createProviderVerificationTransport({
      allowLocalNetworks: false,
      followRedirects: false,
    });
    const response = await transport.fetch('https://provider.example.test/key', {
      method: 'GET',
      headers: { Authorization: 'Bearer user-key' },
    });

    expect(response.status).toBe(302);
    expect(mocks.fetchWithRedirectValidation).not.toHaveBeenCalled();
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      'https://provider.example.test/key',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        dispatcher,
      }),
    );
    await transport.close();
    expect(mocks.dispatcherClose).toHaveBeenCalledOnce();
  });

  it('caps a streamed provider response when content-length is absent', async () => {
    mocks.createValidatedDispatcher.mockReturnValue({ close: mocks.dispatcherClose });
    mocks.fetchWithRedirectValidation.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      ),
    );

    const { createProviderVerificationTransport, ProviderResponseTooLargeError } =
      await import('@/lib/server/provider-verification-transport');
    const transport = createProviderVerificationTransport({ allowLocalNetworks: false });
    const response = await transport.fetch('https://provider.example.test');
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    await transport.close();
  });

  it('rejects a provider response whose declared size exceeds the limit', async () => {
    mocks.createValidatedDispatcher.mockReturnValue({ close: mocks.dispatcherClose });
    mocks.fetchWithRedirectValidation.mockResolvedValue(
      new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    );

    const { createProviderVerificationTransport, ProviderResponseTooLargeError } =
      await import('@/lib/server/provider-verification-transport');
    const transport = createProviderVerificationTransport({ allowLocalNetworks: false });
    await expect(transport.fetch('https://provider.example.test')).rejects.toBeInstanceOf(
      ProviderResponseTooLargeError,
    );
    await transport.close();
  });
});
