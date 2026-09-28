/**
 * POST /api/pbl/v2/instructor
 *
 * Streams one Instructor turn back to the client as Server-Sent
 * Events. The client posts the full `PBLProjectV2` (small enough
 * that round-tripping it is fine, and it keeps the server stateless),
 * plus the learner's message text.
 *
 * The server agent reads the current milestone / microtask out of the
 * project, decides which tools to expose, runs the LLM loop, and
 * streams back token deltas + tool-call records + project_patch
 * events. The client applies the patches to its own copy of
 * `scene.content.projectV2`.
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
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runInstructorTurn, type InstructorPhase } from '@/lib/pbl/v2/agents/instructor';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 Instructor API');

interface InstructorRequest {
  project: PBLProjectV2;
  userMessage: string;
  /** Optional override; defaults to 'instructing'. */
  phase?: InstructorPhase;
}

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const fail = (code: ApiErrorCode, status: number, error: string, details?: string) =>
      withOwnerResponseHeaders(apiError(code, status, error, details), responseHeaders);
    try {
      await consumeActionRateLimit(ownerId, 'pbl_v2_instructor');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return fail('RATE_LIMITED', 429, 'Too many tutoring turns');
      }
      return fail('INTERNAL_ERROR', 503, 'Rate limiting is unavailable');
    }
    const sse = (...args: Parameters<typeof createSSEResponse>) => {
      const response = createSSEResponse(...args);
      for (const [key, value] of responseHeaders) response.headers.append(key, value);
      return response;
    };
    let body: InstructorRequest;
    try {
      body = (await req.json()) as InstructorRequest;
    } catch {
      return fail('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
    }

    if (!body?.project) {
      return fail('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
    }
    if (typeof body.userMessage !== 'string' || body.userMessage.trim().length === 0) {
      return fail('MISSING_REQUIRED_FIELD', 400, '`userMessage` is required.');
    }

    let resolved;
    try {
      resolved = await resolveModelFromRequest(req, body, 'pbl-v2-runtime:instructor');
    } catch (err) {
      log.error('Model resolution failed:', err);
      return fail('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
    }

    const { model, thinkingConfig } = resolved;
    const phase = body.phase ?? 'instructing';
    applyRequestLocaleToProject(req, body.project);

    return sse(
      runInstructorTurn({
        project: body.project,
        userMessage: body.userMessage,
        phase,
        languageModel: model,
        thinkingConfig,
        signal: req.signal,
      }),
      { signal: req.signal },
    );
  });
}
