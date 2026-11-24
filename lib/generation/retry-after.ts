const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** Parse Retry-After seconds or an HTTP date, bounding display and waits to one day. */
export function parseRetryAfterSeconds(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const remainingSeconds = Math.ceil((dateMs - nowMs) / 1000);
  if (remainingSeconds <= 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, remainingSeconds);
}
