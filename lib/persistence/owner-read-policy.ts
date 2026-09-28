/**
 * Legacy deployments retain capability-by-id reads unless they opt in.
 * Enterprise authentication always requires owner-or-public reads.
 */
export function isOwnerReadEnforcementEnabled(): boolean {
  const flag = process.env.OPENMAIC_ENFORCE_OWNER_READS;
  return process.env.OPENMAIC_AUTH_MODE?.trim() === 'oidc' || flag === 'true' || flag === '1';
}
