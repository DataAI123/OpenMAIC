import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  readUsageRecords,
  type UsageRecord,
  type UsageKind,
  type UsageUnit,
} from '@/lib/server/usage-storage';

const log = createLogger('UsageAPI');

interface Bucket {
  key: string;
  kind: UsageKind;
  unit: UsageUnit;
  requests: number;
  // LLM token totals (0 for non-LLM).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedTokens: number;
  totalTokens: number;
  // Non-token quantity (images / seconds / characters).
  quantity: number;
}

function emptyBucket(key: string, kind: UsageKind, unit: UsageUnit): Bucket {
  return {
    key,
    kind,
    unit,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedTokens: 0,
    totalTokens: 0,
    quantity: 0,
  };
}

function unitOf(r: UsageRecord): UsageUnit {
  return r.unit ?? 'token';
}

function addTo(bucket: Bucket, r: UsageRecord): void {
  bucket.requests += 1;
  bucket.inputTokens += r.inputTokens;
  bucket.outputTokens += r.outputTokens;
  bucket.cacheReadTokens += r.cacheReadTokens;
  bucket.cacheCreationTokens += r.cacheCreationTokens;
  bucket.estimatedTokens += r.quotaEstimatedTokens ?? 0;
  // `inputTokens` is the provider-reported prompt token total; for
  // OpenAI-compatible providers it already includes cached input tokens. Keep
  // cache read/write counts as separate breakdown fields, but don't add them
  // again to the displayed aggregate.
  bucket.totalTokens += r.inputTokens + r.outputTokens + (r.quotaEstimatedTokens ?? 0);
  bucket.quantity += r.quantity ?? 0;
}

function dayKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/**
 * GET /api/usage
 *
 * Aggregates usage by model, day, and modality. In OIDC mode only rows for the
 * authenticated owner *in the tenant the session is acting in* are included, so
 * one user who belongs to two tenants sees each tenant's spend separately;
 * legacy mode retains its deployment-wide view. Pure usage — no cost. Optional
 * `?months=YYYY-MM,...`.
 */
export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders, identity) => {
    try {
      const monthsParam = req.nextUrl.searchParams.get('months');
      const months = monthsParam ? monthsParam.split(',').map((s) => s.trim()) : undefined;
      // The owner and tenant ids are derived from a database-backed application
      // session in withRequestOwnerId. Never use a caller-supplied owner/tenant
      // filter. Keep the legacy dashboard contract unchanged during migration.
      const records = await readUsageRecords({
        months,
        ...(ownerId.startsWith('user:') ? { ownerId } : {}),
        ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
      });

      const byModel = new Map<string, Bucket>();
      const byDay = new Map<string, Bucket>();
      const byKind = new Map<UsageKind, Bucket>();
      let totalRequests = 0;
      let totalLlmTokens = 0;

      for (const r of records) {
        totalRequests += 1;
        if (r.kind === 'llm') {
          totalLlmTokens += r.inputTokens + r.outputTokens + (r.quotaEstimatedTokens ?? 0);
        }

        const mk = r.modelString || r.modelId;
        if (!byModel.has(mk)) byModel.set(mk, emptyBucket(mk, r.kind, unitOf(r)));
        addTo(byModel.get(mk)!, r);

        const dk = dayKey(r.createdAt);
        if (!byDay.has(dk)) byDay.set(dk, emptyBucket(dk, 'llm', 'token'));
        addTo(byDay.get(dk)!, r);

        if (!byKind.has(r.kind)) byKind.set(r.kind, emptyBucket(r.kind, r.kind, unitOf(r)));
        addTo(byKind.get(r.kind)!, r);
      }

      const response = apiSuccess({
        totals: { requests: totalRequests, llmTokens: totalLlmTokens },
        byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
        byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
        byKind: [...byKind.values()],
      });
      response.headers.set('Cache-Control', 'no-store');
      return withOwnerResponseHeaders(response, responseHeaders);
    } catch (error) {
      log.error('Usage aggregation failed:', error);
      const response = apiError(
        'INTERNAL_ERROR',
        500,
        error instanceof Error ? error.message : 'Failed to read usage',
      );
      response.headers.set('Cache-Control', 'no-store');
      return withOwnerResponseHeaders(response, responseHeaders);
    }
  });
}
