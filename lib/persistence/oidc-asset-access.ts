import type { AssetPrincipal } from '@openmaic/storage';

export interface AssetAccessQueryable {
  query<TRow extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

interface AssetPrincipalRow extends Record<string, unknown> {
  principal: string;
  owner_match: boolean;
}

/**
 * Resolve an OIDC asset principal from the authenticated owner and database
 * ownership references. Asset ids and learner keys supplied by clients are
 * never treated as proof of access.
 *
 * When `tenantId` is supplied, the owner's own branch additionally requires
 * `entry.tenant_id = tenantId`, and a match there returns a principal that
 * carries the tenant so every later store call is scoped to it -- an entry
 * written under one tenant is not readable through the same user's session in
 * another. The public-course branch is deliberately left un-scoped: a published
 * public course stays readable across tenants (the batch-20 rule), so a match
 * there returns the (foreign) principal without a tenant dimension. Omitted
 * (legacy / single-tenant), the tenant column is not consulted at all.
 */
export async function resolveOidcAssetPrincipal(
  queryable: AssetAccessQueryable,
  ownerId: string,
  request: Pick<Request, 'method' | 'url'>,
  tenantId?: string,
): Promise<AssetPrincipal | undefined> {
  let url: URL;
  try {
    url = new URL(request.url, 'http://persistence.internal');
  } catch {
    return undefined;
  }
  if (url.search || url.hash) return undefined;

  const method = request.method.toUpperCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (method === 'POST' && segments.length === 1 && segments[0] === 'assets') {
    return {
      key: ownerId,
      learnerKey: ownerId,
      ...(tenantId === undefined ? {} : { tenantId }),
    };
  }

  if (
    !['GET', 'HEAD'].includes(method) ||
    segments.length !== 3 ||
    segments[0] !== 'assets' ||
    segments[2] !== 'content'
  ) {
    return undefined;
  }

  let assetId: string;
  try {
    assetId = decodeURIComponent(segments[1]!);
  } catch {
    return undefined;
  }
  if (!assetId || assetId.includes('/') || assetId.includes('\0')) return undefined;

  const ownerTenantFilter = tenantId === undefined ? '' : ' AND entry.tenant_id = $3';
  const result = await queryable.query<AssetPrincipalRow>(
    `SELECT entry.principal,
            (entry.principal = $2) AS owner_match
       FROM asset_entries AS entry
      WHERE entry.id = $1
        AND (
          (entry.principal = $2${ownerTenantFilter})
          OR EXISTS (
            SELECT 1
              FROM document_asset_refs AS refs
              JOIN stage_meta AS meta ON meta.stage_id = refs.stage_id
             WHERE refs.asset_id = entry.id
               AND meta.deleted_at IS NULL
               AND meta.is_public IS TRUE
               AND (
                 entry.principal = meta.owner_id
                 OR (entry.principal = 'shared' AND meta.owner_id LIKE 'anon:%')
               )
          )
        )`,
    tenantId === undefined ? [assetId, ownerId] : [assetId, ownerId, tenantId],
  );
  const row = result.rows[0];
  if (!row || typeof row.principal !== 'string') return undefined;
  const base = { key: row.principal, learnerKey: ownerId };
  return tenantId !== undefined && row.owner_match ? { ...base, tenantId } : base;
}
