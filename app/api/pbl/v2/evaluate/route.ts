/**
 * POST /api/pbl/v2/evaluate
 *
 * Three-in-one SSE entry point for PBL v2 evaluations. The client
 * picks the kind via the request body:
 *
 *   { kind: 'task', milestoneId, microtaskId, project }
 *   { kind: 'milestone', milestoneId, project }
 *   { kind: 'final', project }
 *
 * Same wire shape as `/api/pbl/v2/instructor`: SSE stream of
 * PBLSSEEvent, ending with a final `done` after a `project_patch`
 * carrying the new PBLEvaluation. Client wraps the evaluation into
 * either a task-eval card (in-chat), a milestone+handover card
 * (chat), or the completion page (separate UI).
 *
 * The route is stateless: the client owns the project clone and
 * sends it in the body. The server mutates the clone and the patch
 * event tells the client what changed. Same pattern as instructor
 * route — see `app/api/pbl/v2/instructor/route.ts`.
 *
 * Why kind-as-body not kind-as-URL: the three runs all need the
 * same model resolution, headers, project decoding, and SSE
 * heartbeat plumbing — keeping them on one route avoids three
 * near-identical handlers. The trade-off is a runtime switch on a
 * string, which is cheap and obvious.
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, type ApiErrorCode } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  consumeActionRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';

import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import {
  runFinalEvaluation,
  runMilestoneEvaluation,
  runTaskEvaluation,
} from '@/lib/pbl/v2/agents/evaluator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 Evaluate API');

type EvalKind = 'task' | 'milestone' | 'final';

interface EvaluateRequest {
  project: PBLProjectV2;
  kind: EvalKind;
  milestoneId?: string;
  microtaskId?: string;
  recentChatSummary?: string;
}

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const fail = (code: ApiErrorCode, status: number, error: string, details?: string) =>
      withOwnerResponseHeaders(apiError(code, status, error, details), responseHeaders);
    try {
      await consumeActionRateLimit(ownerId, 'pbl_v2_evaluate');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return fail('RATE_LIMITED', 429, 'Too many evaluation requests');
      }
      return fail('INTERNAL_ERROR', 503, 'Rate limiting is unavailable');
    }
    const sse = (...args: Parameters<typeof createSSEResponse>) => {
      const response = createSSEResponse(...args);
      for (const [key, value] of responseHeaders) response.headers.append(key, value);
      return response;
    };
    let body: EvaluateRequest;
    try {
      body = (await req.json()) as EvaluateRequest;
    } catch {
      return fail('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
    }

    if (!body?.project) {
      return fail('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
    }
    if (body.kind !== 'task' && body.kind !== 'milestone' && body.kind !== 'final') {
      return fail('INVALID_REQUEST', 400, "`kind` must be 'task' | 'milestone' | 'final'.");
    }
    if (body.kind === 'task' && (!body.milestoneId || !body.microtaskId)) {
      return fail(
        'MISSING_REQUIRED_FIELD',
        400,
        "kind='task' requires both milestoneId and microtaskId.",
      );
    }
    if (body.kind === 'milestone' && !body.milestoneId) {
      return fail('MISSING_REQUIRED_FIELD', 400, "kind='milestone' requires milestoneId.");
    }

    let resolved;
    try {
      resolved = await resolveModelFromRequest(req, body, 'pbl-v2-runtime:evaluate');
    } catch (err) {
      log.error('Model resolution failed:', err);
      return fail('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
    }
    const { model, thinkingConfig, modelInfo } = resolved;
    const hasVision = !!modelInfo?.capabilities?.vision;

    if (body.kind === 'task') {
      return sse(
        runTaskEvaluation({
          project: body.project,
          milestoneId: body.milestoneId!,
          microtaskId: body.microtaskId!,
          languageModel: model,
          thinkingConfig,
          recentChatSummary: body.recentChatSummary,
          hasVision,
          signal: req.signal,
        }),
        { signal: req.signal },
      );
    }
    if (body.kind === 'milestone') {
      return sse(
        runMilestoneEvaluation({
          project: body.project,
          milestoneId: body.milestoneId!,
          languageModel: model,
          thinkingConfig,
          recentChatSummary: body.recentChatSummary,
          signal: req.signal,
        }),
        { signal: req.signal },
      );
    }
    // final
    return sse(
      runFinalEvaluation({
        project: body.project,
        languageModel: model,
        thinkingConfig,
        recentChatSummary: body.recentChatSummary,
        signal: req.signal,
      }),
      { signal: req.signal },
    );
  });
}
