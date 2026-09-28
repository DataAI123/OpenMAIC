import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';
import { fetchModels } from '@/lib/server/model-fetch';

/** Fetch BYOK models with strict connect-time DNS pinning and no redirect following. */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  options: { modelsUrlOverride?: string },
) {
  const dispatcher = createValidatedDispatcher({ allowLocalNetworks: false });
  try {
    return await fetchModels(baseUrl, apiKey, {
      ...options,
      fetchImpl: (input, init) =>
        undiciFetch(String(input), {
          ...init,
          dispatcher,
        } as UndiciRequestInit) as unknown as Promise<Response>,
    });
  } finally {
    await dispatcher.close();
  }
}
