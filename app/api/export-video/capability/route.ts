import { apiSuccess } from '@/lib/server/api-response';
import { getRenderServiceCapability } from '@/lib/server/render-service';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. "Available" means the
 * service is configured AND its `/health` responds — so a configured-but-absent
 * service (e.g. RENDER_SERVICE_URL set but the container not started) reports
 * disabled and the menu shows only "Download ZIP" rather than advertising an
 * MP4 export that would then fail. Never leaks the service URL to the client.
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req.headers);
  const capability = await getRenderServiceCapability(requestId);
  const response = apiSuccess({ ...capability });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}
