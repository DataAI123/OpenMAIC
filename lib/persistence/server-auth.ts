/**
 * Legacy DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * The token is NOT a secret: NEXT_PUBLIC_PERSISTENCE_TOKEN is compiled into
 * the public browser bundle, so it is fully visible to every visitor and
 * provides no confidentiality and no user isolation.
 *
 * In legacy mode this authenticator is consulted for `/runtime/*`. The OIDC
 * path derives runtime and document principals from the verified application
 * session and does not use this public development token. Assets remain on a
 * shared legacy principal and are closed in OIDC mode until ownership is
 * implemented. `x-learner-key` is never an identity credential.
 *
 * Suitable only for localhost or trusted-network, single-user deployments.
 * Production legacy deployments must not enable this authenticator. OIDC
 * requests are handled by the persistence route's application-session path.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AssetPrincipal } from '@openmaic/storage';
import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

import { createLogger } from '@/lib/logger';

const log = createLogger('PersistenceAuth');

type PersistencePrincipal = RuntimeHttpPrincipal & Partial<Pick<AssetPrincipal, 'key'>>;

/**
 * The shared asset partition used by legacy deployments. OIDC asset requests
 * use a per-user principal and public-reference checks in the persistence
 * route instead.
 *
 * Exported because the persistence route resolves the legacy asset principal
 * server-side rather than through client-supplied credentials.
 */
export const SHARED_ASSET_PRINCIPAL = 'shared';

/**
 * Whether the operator explicitly opted the development authenticator into
 * production traffic (PERSISTENCE_ALLOW_INSECURE_DEV_AUTH=true/1). Both the
 * startup warning and the runtime gate read the same opt-in through this one
 * helper so the two copies of the parsing cannot drift.
 */
function insecureDevAuthOptInEnabled(): boolean {
  const optIn = process.env.PERSISTENCE_ALLOW_INSECURE_DEV_AUTH;
  return optIn === 'true' || optIn === '1';
}

/**
 * The development authenticator must never serve production traffic unless the
 * operator explicitly accepts the trade-off. This module provides no user
 * isolation, so production defaults to refusing it entirely (returns undefined,
 * which callers turn into a 401); PERSISTENCE_ALLOW_INSECURE_DEV_AUTH=true is
 * the documented opt-in for trusted-network single-user deployments.
 */
function devAuthenticatorAllowedInCurrentEnvironment(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return insecureDevAuthOptInEnabled();
}

if (process.env.NODE_ENV === 'production' && insecureDevAuthOptInEnabled()) {
  log.warn(
    'Persistence is running the development authenticator in production: it provides no user ' +
      'isolation, so this endpoint must only be reachable on a trusted network. Replace it with ' +
      'real session verification before serving public traffic.',
  );
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function authenticatePersistenceCredentials(
  authorization: string | undefined,
  learnerKey: string | undefined,
): PersistencePrincipal | undefined {
  if (!devAuthenticatorAllowedInCurrentEnvironment()) return undefined;

  const token = process.env.PERSISTENCE_DEV_TOKEN;
  if (!token || !authorization || !secureEqual(authorization, `Bearer ${token}`)) return undefined;

  // Legacy documents are stored without an ownership partition, so legacy
  // assets share one principal as well. OIDC deployments bypass this
  // development authenticator and use the internal user id.
  // A per-header asset partition only meant a converted document's assets
  // became unreadable to every other browser the document was shared with.
  // The learner key still partitions runtime sessions, which are genuinely
  // per-learner state.
  return { key: SHARED_ASSET_PRINCIPAL, ...(learnerKey ? { learnerKey } : {}) };
}

export function authenticatePersistenceHeaders(headers: Headers): PersistencePrincipal | undefined {
  return authenticatePersistenceCredentials(
    headers.get('authorization') ?? undefined,
    headers.get('x-learner-key') ?? undefined,
  );
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<PersistencePrincipal | undefined> {
  return authenticatePersistenceCredentials(
    singleHeader(req.headers.authorization),
    singleHeader(req.headers['x-learner-key']),
  );
}
