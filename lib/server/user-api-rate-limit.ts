import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const USER_OWNER_PREFIX = 'user:';
const PROBE_ROUTE_KEY = 'provider_probe_models';
const VERIFY_MODEL_ROUTE_KEY = 'verify_model';
const AZURE_VOICES_ROUTE_KEY = 'azure_voices';
const VERIFY_PDF_ROUTE_KEY = 'verify_pdf_provider';
const VERIFY_IMAGE_ROUTE_KEY = 'verify_image_provider';
const VERIFY_VIDEO_ROUTE_KEY = 'verify_video_provider';
const PROBE_LIMIT = 5;
const PROBE_WINDOW_SECONDS = 60;
// The media proxy is a high-frequency route: one course persists ~40 remote
// assets (images + audio) in a burst through it, so the default 5/min action
// budget would abort a legitimate first save. 60/min absorbs that burst with
// headroom while still bounding scripted abuse. The 60-second window is shared
// with every other route key.
const PROXY_MEDIA_LIMIT = 60;

/** Route keys for the stateless LLM/voice action routes opened under OIDC. */
export const ACTION_RATE_LIMIT_ROUTES = [
  'api_chat',
  'chat_pi',
  'generate_scene_content',
  'generate_scene_actions',
  'generate_scene_outlines_stream',
  'generate_agent_profiles',
  'generate_voice',
  'quiz_grade',
  'pbl_v2_instructor',
  'pbl_v2_evaluate',
  'pbl_v2_open_task',
  'pbl_v2_simulator',
  'pbl_v2_task_update',
  'extract_document',
  'transcription',
  'parse_pdf',
  'proxy_media',
  'classroom_store',
  'generate_classroom',
  'web_search',
] as const;
export type ActionRateLimitRoute = (typeof ACTION_RATE_LIMIT_ROUTES)[number];

type UserApiRateLimitRoute =
  | typeof PROBE_ROUTE_KEY
  | typeof VERIFY_MODEL_ROUTE_KEY
  | typeof AZURE_VOICES_ROUTE_KEY
  | typeof VERIFY_PDF_ROUTE_KEY
  | typeof VERIFY_IMAGE_ROUTE_KEY
  | typeof VERIFY_VIDEO_ROUTE_KEY
  | ActionRateLimitRoute;

export class UserApiRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('User API rate limit exceeded');
    this.name = 'UserApiRateLimitExceededError';
  }
}

/** Atomically allow at most five model probes per user in each 60-second window. */
export async function consumeProbeRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, PROBE_ROUTE_KEY);
}

export async function consumeModelVerificationRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, VERIFY_MODEL_ROUTE_KEY);
}

/** Atomically allow at most five Azure voice-list requests per user per minute. */
export async function consumeAzureVoicesRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, AZURE_VOICES_ROUTE_KEY);
}

/** Atomically allow at most five PDF provider verifications per user per minute. */
export async function consumePdfProviderVerificationRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, VERIFY_PDF_ROUTE_KEY);
}

/** Atomically allow at most five BYOK image provider verifications per user per minute. */
export async function consumeImageProviderVerificationRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, VERIFY_IMAGE_ROUTE_KEY);
}

export async function consumeVideoProviderVerificationRateLimit(ownerId: string): Promise<void> {
  return consumeUserApiRateLimit(ownerId, VERIFY_VIDEO_ROUTE_KEY);
}

/**
 * Fixed-window check for the stateless action routes (chat turns, scene/PBL
 * generation, grading, voice). Legacy anonymous owners are skipped: the
 * counter is per authenticated user, and legacy deployments keep their
 * pre-OIDC posture. Under OIDC every request that reaches a handler is a
 * `user:` owner, so the check is always enforced in enterprise mode. `limit`
 * defaults to the shared 5-req/60s action budget; only route keys with a
 * documented higher ceiling (the media proxy) override it.
 */
export async function consumeActionRateLimit(
  ownerId: string,
  routeKey: ActionRateLimitRoute,
  limit: number = PROBE_LIMIT,
): Promise<void> {
  if (!ownerId.startsWith(USER_OWNER_PREFIX)) return;
  return consumeUserApiRateLimit(ownerId, routeKey, limit);
}

/**
 * Fixed-window check for the high-frequency media proxy. Allowed 60 requests
 * per user per 60 seconds so one course's asset burst (~40 downloads) fits with
 * headroom; see PROXY_MEDIA_LIMIT.
 */
export async function consumeProxyMediaRateLimit(ownerId: string): Promise<void> {
  return consumeActionRateLimit(ownerId, 'proxy_media', PROXY_MEDIA_LIMIT);
}

async function consumeUserApiRateLimit(
  ownerId: string,
  routeKey: UserApiRateLimitRoute,
  limit: number = PROBE_LIMIT,
): Promise<void> {
  if (!ownerId.startsWith(USER_OWNER_PREFIX) || ownerId.length === USER_OWNER_PREFIX.length) {
    throw new Error('USER_API_RATE_LIMIT_REQUIRES_AUTHENTICATED_USER');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('USER_API_RATE_LIMIT_DATABASE_UNAVAILABLE');
  const { pool } = await getServerPersistenceProvider(connectionString);
  const userId = ownerId.slice(USER_OWNER_PREFIX.length);
  const result = await pool.query<{ window_started_at: Date | string }>(
    `INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
     VALUES ($1, $2, CURRENT_TIMESTAMP, 1)
     ON CONFLICT (user_id, route_key) DO UPDATE
       SET window_started_at = CASE
             WHEN user_api_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
               THEN CURRENT_TIMESTAMP
             ELSE user_api_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN user_api_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
               THEN 1
             ELSE user_api_rate_limits.request_count + 1
           END
       WHERE user_api_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
          OR user_api_rate_limits.request_count < $3
     RETURNING window_started_at`,
    [userId, routeKey, limit],
  );
  const windowStartedAt = result.rows[0]?.window_started_at;
  if (windowStartedAt !== undefined) return;

  // No row was admitted. This read is only for a helpful Retry-After value;
  // the upsert above is the authoritative, race-safe decision.
  const current = await pool.query<{ retry_after: number }>(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM
       (window_started_at + INTERVAL '60 seconds' - CURRENT_TIMESTAMP)))::integer) AS retry_after
       FROM user_api_rate_limits WHERE user_id = $1 AND route_key = $2`,
    [userId, routeKey],
  );
  throw new UserApiRateLimitExceededError(current.rows[0]?.retry_after ?? PROBE_WINDOW_SECONDS);
}
