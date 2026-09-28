import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import type { NextRequest } from 'next/server';

const log = createLogger('ServerProviders');

export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (_ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    try {
      return ownerJson(
        {
          success: true,
          providers: getServerProviders(),
          tts: getServerTTSProviders(),
          asr: getServerASRProviders(),
          pdf: getServerPDFProviders(),
          image: getServerImageProviders(),
          video: getServerVideoProviders(),
          webSearch: getServerWebSearchProviders(),
          generation: {
            parallelSceneConcurrency: getParallelSceneConcurrency(),
          },
        },
        200,
        responseHeaders,
      );
    } catch (error) {
      log.error('Error fetching server providers:', error);
      return ownerApiError(
        'INTERNAL_ERROR',
        500,
        error instanceof Error ? error.message : 'Unknown error',
        responseHeaders,
      );
    }
  });
}
