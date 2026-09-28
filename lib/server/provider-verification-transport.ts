import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Dispatcher,
} from 'undici';

import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';
import {
  fetchWithRedirectValidation,
  type RedirectValidationFetch,
} from '@/lib/server/fetch-with-redirect-validation';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export class ProviderResponseTooLargeError extends Error {
  constructor() {
    super('Provider verification response exceeded its limit');
    this.name = 'ProviderResponseTooLargeError';
  }
}

/**
 * Transport policy for a provider key probe: never follow a redirect (it would
 * carry the caller's key off-origin) and never reach a private-network target.
 * Routes read the policy from here so the vendor-neutral route surface does not
 * have to name transport hardening flags itself.
 */
export function keyProbeTransportOptions(): {
  allowLocalNetworks: boolean;
  followRedirects: boolean;
} {
  return { allowLocalNetworks: false, followRedirects: false };
}

/** Transport for one provider verification; pins DNS answers and caps response bytes. */
export function createProviderVerificationTransport(options: {
  allowLocalNetworks: boolean;
  /** Reject 3xx responses instead of following validated redirect hops. */
  followRedirects?: boolean;
}): {
  fetch: typeof fetch;
  close: () => Promise<void>;
} {
  const dispatcher = createValidatedDispatcher({
    allowLocalNetworks: options.allowLocalNetworks,
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
    connectTimeout: 5000,
  });
  const fetchImpl: RedirectValidationFetch = (input, init) =>
    undiciFetch(input, {
      ...init,
      dispatcher,
    } as UndiciRequestInit) as unknown as Promise<Response>;

  return {
    fetch: (async (input, init) => {
      const response =
        options.followRedirects === false
          ? ((await undiciFetch(
              input as Parameters<typeof undiciFetch>[0],
              {
                ...init,
                redirect: 'manual',
                dispatcher,
              } as UndiciRequestInit,
            )) as unknown as Response)
          : await fetchWithRedirectValidation(input, init, {
              fetchImpl,
              dispatcher: dispatcher as Dispatcher,
              allowLocalNetworks: options.allowLocalNetworks,
            });
      return limitResponseBody(response);
    }) as typeof fetch,
    close: async () => {
      await dispatcher.close();
    },
  };
}

function limitResponseBody(response: Response): Response {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderResponseTooLargeError();
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let bytesRead = 0;
  let readerReleased = false;
  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseReader();
          return;
        }
        bytesRead += value.byteLength;
        if (bytesRead > MAX_PROVIDER_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          releaseReader();
          controller.error(new ProviderResponseTooLargeError());
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
