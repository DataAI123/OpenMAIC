import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { resolveAuthConfig } from '@/lib/server/auth/config';
import { stampRequestId } from '@/lib/server/request-id';

async function handleGet() {
  // OIDC deployments disable the access-code channel outright. Middleware admits
  // this probe so the app-wide AccessCodeGuard reads `enabled: false` instead of
  // falling back to its fail-closed default and rendering a modal that no code
  // can ever satisfy. It never mints or accepts a credential in OIDC mode, so
  // this is a plain status read, not a login channel.
  let legacy: boolean;
  try {
    legacy = resolveAuthConfig().mode === 'legacy';
  } catch {
    // Unreadable auth configuration fails closed: never advertise a channel we
    // cannot place under the enterprise gate.
    legacy = false;
  }
  if (!legacy) {
    const response = apiSuccess({ enabled: false, authenticated: false });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({ enabled, authenticated });
}

export async function GET(request: Request) {
  try {
    return stampRequestId(await handleGet(), request.headers);
  } catch (error) {
    console.error(
      '[access-code] status route failed',
      error instanceof Error ? error.name : 'unknown',
    );
    const response = apiError('INTERNAL_ERROR', 503, 'Authentication status unavailable');
    response.headers.set('Cache-Control', 'no-store');
    return stampRequestId(response, request.headers);
  }
}
