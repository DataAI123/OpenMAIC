import { apiSuccess } from '@/lib/server/api-response';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';

/** Process liveness only; dependency readiness is exposed separately. */
export function GET(request: Request) {
  const response = apiSuccess({ status: 'ok' });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set(REQUEST_ID_HEADER, resolveRequestId(request.headers));
  return response;
}
