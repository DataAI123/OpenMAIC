import { apiError, apiSuccess } from '@/lib/server/api-response';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';

const version = process.env.npm_package_version || '0.1.0';

export async function GET(req: Request) {
  const requestId = resolveRequestId(req.headers);
  try {
    const response = apiSuccess({
      status: 'ok',
      version,
      accessCodeConfigured: Boolean(process.env.ACCESS_CODE),
      capabilities: {
        // A capability is available only when at least one provider is enabled —
        // force-disabled providers (disabled: true) do not count (#665).
        webSearch: Object.values(getServerWebSearchProviders()).some((info) => !info.disabled),
        imageGeneration: Object.values(getServerImageProviders()).some((info) => !info.disabled),
        videoGeneration: Object.values(getServerVideoProviders()).some((info) => !info.disabled),
        tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
      },
    });
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch (error) {
    console.error(
      `[health] failed to resolve capabilities (requestId=${requestId})`,
      error instanceof Error ? error.name : 'unknown',
    );
    const response = apiError('UPSTREAM_ERROR', 503, 'Health status is unavailable');
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }
}
