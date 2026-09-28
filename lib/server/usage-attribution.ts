import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Server-derived attribution for the usage currently being recorded.
 *
 * Usage rows used to be deployment-wide: they carried only model/provider/
 * token counts, so a multi-user OIDC deployment could not answer "whose spend
 * is this" and could not later enforce per-user budgets. This context lets the
 * request/run boundary attach the authenticated principal to every
 * `recordUsage` in its async scope WITHOUT the generation call sites or the
 * client ever supplying an owner id — the value only ever comes from a
 * server-resolved session, never from request input.
 */
export interface UsageAttribution {
  /**
   * Resolved owner partition key: `user:<id>` for OIDC principals,
   * `anon:<id>` for legacy anonymous owners, `public:anonymous` for guests.
   */
  ownerId: string;
  /** Enterprise tenant id. Present only for authenticated OIDC principals. */
  tenantId?: string;
}

const OIDC_USER_PREFIX = 'user:';
// Phase 1 is a single controlled organization; every OIDC membership lives in
// the seeded `default` tenant (see migrations/0001_enterprise_identity.sql).
const DEFAULT_TENANT = 'default';

const attributionGlobal = globalThis as typeof globalThis & {
  __usageAttributionContext?: AsyncLocalStorage<UsageAttribution | undefined>;
};

// Next.js evaluates server modules separately per entry (instrumentation vs
// route). Reuse one store so a later evaluation cannot replace the store the
// runner/request boundary wrote into. Mirrors `thinking-context`.
export const usageAttributionContext = (attributionGlobal.__usageAttributionContext ??=
  new AsyncLocalStorage<UsageAttribution | undefined>());

/** Run `fn`, attributing any usage it records (including fire-and-forget writes). */
export function runWithUsageAttribution<T>(attribution: UsageAttribution, fn: () => T): T {
  return usageAttributionContext.run(attribution, fn);
}

/** The attribution for the current async scope, or undefined outside one. */
export function currentUsageAttribution(): UsageAttribution | undefined {
  return usageAttributionContext.getStore();
}

/**
 * Derive attribution from an already-resolved owner id. An explicit `tenantId`
 * — always a server-resolved session or claimed-session value — wins, so a user
 * acting in a non-default tenant is attributed to the tenant they acted in.
 * Callers that only know the owner id fall back to the phase-1 mapping: `user:`
 * owners to the controlled `default` tenant, legacy `anon:` / `public:` owners
 * to no tenant. The owner id must come from server session resolution — this
 * helper performs no trust of its own.
 */
export function attributionForOwner(ownerId: string, tenantId?: string): UsageAttribution {
  if (tenantId) return { ownerId, tenantId };
  return ownerId.startsWith(OIDC_USER_PREFIX) ? { ownerId, tenantId: DEFAULT_TENANT } : { ownerId };
}
