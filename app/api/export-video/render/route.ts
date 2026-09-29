import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import { capBodyStream } from '@/lib/server/capped-stream';
import { clientIdentity } from '@/lib/server/client-identity';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { attachOwnerHeaders } from '@/lib/server/export-render-access';
import {
  checkRenderSubmitLimit,
  isSafeRenderJobId,
  recordRenderJobOwner,
} from '@/lib/server/export-render-jobs';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Render API');

// Only forwards the upload to the isolated render service; the render itself
// happens there, so this route stays lightweight despite large ZIP bodies. The
// budget must cover *uploading* up to MAX_UPLOAD_BYTES over a slow link (a
// 300 MB body needs ~40 Mbps to finish in 60s), not the render — so it's sized
// for the transfer, well above the old 60s.
export const maxDuration = 300;

/** Reject uploads larger than this (compressed ZIP bytes), enforced on real bytes. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** Upload-forwarding budget. Covers a large body over a slow link; the render is async. */
const SUBMIT_TIMEOUT_MS = 300_000;

/**
 * Submit an export ZIP for MP4 rendering. Streams the multipart body straight
 * to the render service (no `formData()` buffering here) and relays its
 * `202 { jobId }`. Returns 501 when the service is not configured so the client
 * can degrade to a local ZIP download.
 *
 * The returned jobId is bound to the caller before it is advertised: the render
 * service itself has no owner concept, so the app records the (job → owner)
 * mapping that poll/cancel/download later enforce. If that binding cannot be
 * written, the just-created job is best-effort cancelled and the request fails
 * closed — an unbound job must never reach a client.
 *
 * Submits are also bounded per (owner, tenant) by a soft in-flight concurrency
 * cap counted from those same bindings; an over-cap submit is refused with 429
 * before any bytes reach the render service. See {@link checkRenderSubmitLimit}.
 */
export async function POST(req: NextRequest) {
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) {
    return apiError('PROVIDER_DISABLED', 501, 'Render service is not configured');
  }

  // Fast-path reject an oversized body by its declared length. This is only a
  // courtesy 413 for honest clients — `Content-Length` is client-supplied and
  // omitted on chunked uploads, so the real bound is the byte-counting cap on
  // the stream below (belt-and-suspenders with the service's own archive guards).
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return apiError('INVALID_REQUEST', 413, 'Export archive is too large');
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders, identity) => {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data') || !req.body) {
      return attachOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data'),
        responseHeaders,
      );
    }

    // Per-owner concurrency cap, checked before any bytes are forwarded so an
    // over-cap submit costs the render service nothing. Only `user:` owners are
    // limited: the counter is per authenticated user, and legacy anonymous
    // deployments (all sharing one `anon:` id) keep their pre-OIDC posture —
    // enforcing here would make every legacy user contend for one shared window.
    // Under OIDC every submit that reaches this handler is a `user:` owner, so
    // the cap is always enforced in enterprise mode. Fails closed: a store
    // outage refuses the submit rather than letting an unbounded job through.
    if (ownerId.startsWith('user:')) {
      let limit: Awaited<ReturnType<typeof checkRenderSubmitLimit>>;
      try {
        limit = await checkRenderSubmitLimit(ownerId, identity?.tenantId);
      } catch (error) {
        log.error('Render submit concurrency check failed; refusing submit:', error);
        return attachOwnerHeaders(
          apiError('UPSTREAM_ERROR', 503, 'Render job concurrency check is unavailable'),
          responseHeaders,
        );
      }
      if (limit.limited) {
        responseHeaders.set('Retry-After', String(limit.retryAfterSeconds ?? 0));
        return attachOwnerHeaders(
          apiError('RATE_LIMITED', 429, 'Too many concurrent render jobs'),
          responseHeaders,
        );
      }
    }

    // Forward the raw multipart body verbatim, bounded to MAX_UPLOAD_BYTES of
    // actual bytes. We deliberately do NOT parse it: the render service derives
    // its per-IP rate-limit identity from the header below and ignores any
    // multipart `userId`, so there's nothing to strip — and re-parsing would
    // defeat the streaming bound.
    const capped = capBodyStream(req.body, MAX_UPLOAD_BYTES);

    try {
      // Long enough for the upload of a multi-MB ZIP; the render is async.
      const upstream = await proxyFetch(`${resolved.url}/render`, {
        method: 'POST',
        body: capped.stream,
        // duplex is required to send a streaming request body via fetch.
        duplex: 'half',
        headers: {
          'content-type': contentType,
          'x-openmaic-client': clientIdentity(req),
        },
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      } as RequestInit);

      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (!upstream.ok) {
        const detail = typeof data.error === 'string' ? data.error : upstream.statusText;
        const status = upstream.status === 429 ? 429 : upstream.status === 413 ? 413 : 502;
        const code =
          upstream.status === 429
            ? 'RATE_LIMITED'
            : upstream.status === 413
              ? 'INVALID_REQUEST'
              : 'UPSTREAM_ERROR';
        return attachOwnerHeaders(
          apiError(code, status, 'Render service rejected the request', detail),
          responseHeaders,
        );
      }

      const jobId = data.jobId;
      if (!isSafeRenderJobId(jobId)) {
        // The service handed back a job id we cannot bind; refuse rather than
        // advertise an unattributable job, and try to reclaim it upstream.
        log.error('Render service returned an unusable job id; discarding job');
        await cancelUpstreamJob(resolved.url, String(jobId ?? ''));
        return attachOwnerHeaders(
          apiError('UPSTREAM_ERROR', 502, 'Render service returned an invalid job id'),
          responseHeaders,
        );
      }

      try {
        await recordRenderJobOwner(jobId, ownerId, identity?.tenantId);
      } catch (error) {
        // Ownership binding is mandatory and fail-closed: a job the app cannot
        // attribute must not be handed to the client. Best-effort cancel it.
        log.error(`Failed to bind render job ${jobId} to its owner; cancelling:`, error);
        await cancelUpstreamJob(resolved.url, jobId);
        return attachOwnerHeaders(
          apiError('UPSTREAM_ERROR', 503, 'Render job could not be registered'),
          responseHeaders,
        );
      }

      return attachOwnerHeaders(apiSuccess({ jobId, pollIntervalMs: 3000 }, 202), responseHeaders);
    } catch (error) {
      // A cap trip aborts the forwarded stream, surfacing here as a fetch error.
      if (capped.exceeded()) {
        return attachOwnerHeaders(
          apiError('INVALID_REQUEST', 413, 'Export archive is too large'),
          responseHeaders,
        );
      }
      log.error('Failed to submit render job:', error);
      return attachOwnerHeaders(
        apiError(
          'UPSTREAM_ERROR',
          502,
          'Failed to reach render service',
          error instanceof Error ? error.message : String(error),
        ),
        responseHeaders,
      );
    }
  });
}

/** Best-effort upstream cancel so a job we refuse to bind does not linger. */
async function cancelUpstreamJob(baseUrl: string, jobId: string): Promise<void> {
  if (!jobId) return;
  await proxyFetch(`${baseUrl}/render/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}
