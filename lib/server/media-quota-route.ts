import {
  PersonalMediaQuotaExceededError,
  reservePersonalMediaQuota,
  settlePersonalMediaQuota,
  type MediaQuotaModality,
} from '@/lib/server/personal-modality-quota';
import { currentUsageAttribution } from '@/lib/server/usage-attribution';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaQuotaRoute');

/**
 * Route-level gate for the personal media quota. Personal quotas only apply to
 * authenticated `user:` principals; legacy anonymous owners keep the existing
 * deployment-wide behavior and are skipped here. The generate routes stay behind
 * the OIDC middleware 503 gate, so the reserved path is dormant until a route is
 * explicitly opened — building it first keeps opening a pure allowlist change.
 */
export type MediaQuotaGate =
  | { kind: 'skip' }
  | { kind: 'reserved'; reservationId: string; reservedAmount: number }
  | { kind: 'exceeded' }
  | { kind: 'unavailable'; reason: unknown };

export async function beginMediaQuota(
  ownerId: string,
  modality: MediaQuotaModality,
  reserveAmount: number,
): Promise<MediaQuotaGate> {
  if (!ownerId.startsWith('user:')) return { kind: 'skip' };
  try {
    // The tenant comes from the same request boundary that resolved `ownerId`
    // (`withRequestOwnerId`), so a user acting in one tenant never draws another
    // tenant's monthly budget. Outside an attributed scope the tenant is absent
    // and the engine falls back to the controlled `default` tenant, keeping the
    // legacy single-tenant reservation shape.
    const tenantId = currentUsageAttribution()?.tenantId;
    const reservation = tenantId
      ? await reservePersonalMediaQuota(ownerId, modality, reserveAmount, undefined, tenantId)
      : await reservePersonalMediaQuota(ownerId, modality, reserveAmount);
    return { kind: 'reserved', reservationId: reservation.id, reservedAmount: reserveAmount };
  } catch (error) {
    if (error instanceof PersonalMediaQuotaExceededError) return { kind: 'exceeded' };
    // Policy missing, database unavailable, or an unreviewed modality: fail closed
    // rather than let an authenticated request generate without a metered bound.
    return { kind: 'unavailable', reason: error };
  }
}

/**
 * Commit the metered charge. A post-provider-call error still charges the full
 * reservation (the request may have been billed upstream), mirroring the LLM
 * quota boundary. Accounting failures are logged, never surfaced to the caller,
 * because they must not turn a completed (or already-attempted) generation into a
 * misleading 5xx for the user.
 */
export async function settleMediaQuota(
  gate: MediaQuotaGate,
  actualAmount: number | null,
): Promise<void> {
  if (gate.kind !== 'reserved') return;
  const amount = actualAmount ?? gate.reservedAmount;
  const safe = Number.isSafeInteger(amount) && amount > 0 ? amount : gate.reservedAmount;
  try {
    await settlePersonalMediaQuota(gate.reservationId, safe);
  } catch (error) {
    log.error('Failed to settle personal media quota reservation', error);
  }
}
