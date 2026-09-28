import type { AssetPrincipal } from '@openmaic/storage';

export interface AssetAccessQueryable {
  query<TRow extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

interface AssetPrincipalRow extends Record<string, unknown> {
  principal: string;
}

/**
 * Resolve an OIDC asset principal from the authenticated owner and database
 * ownership references. Asset ids and learner keys supplied by clients are
 * never treated as proof of access.
 */
export async function resolveOidcAssetPrincipal(
  queryable: AssetAccessQueryable,
  ownerId: string,
  request: Pick<Request, 'method' | 'url'>,
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
    return { key: ownerId, learnerKey: ownerId };
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

  const result = await queryable.query<AssetPrincipalRow>(
    `SELECT entry.principal
       FROM asset_entries AS entry
      WHERE entry.id = $1
        AND (
          entry.principal = $2
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
    [assetId, ownerId],
  );
  const principal = result.rows[0]?.principal;
  return typeof principal === 'string' ? { key: principal, learnerKey: ownerId } : undefined;
}
