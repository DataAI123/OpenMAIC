import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { resolveAuthConfig } from '@/lib/server/auth/config';

export async function GET() {
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
