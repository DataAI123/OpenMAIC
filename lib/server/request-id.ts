/**
 * Request correlation ids.
 *
 * Every enterprise response echoes `x-request-id` so a client can pair a
 * failure with the server log line that explains it. A well-formed id supplied
 * by an upstream proxy is adopted verbatim; anything missing or malformed is
 * replaced by a freshly minted UUID, so a caller can never smuggle a
 * header-breaking value into our responses or logs.
 *
 * This module is deliberately edge-safe: it relies on the Web Crypto global
 * rather than `node:crypto`, so `middleware.ts` can import it too.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** Conservative shape for an adopted id: printable, no whitespace, no delimiters. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Adopt a well-formed upstream `x-request-id`, otherwise mint a UUID. */
export function resolveRequestId(headers: Pick<Headers, 'get'>): string {
  const upstream = headers.get(REQUEST_ID_HEADER)?.trim();
  if (upstream && REQUEST_ID_PATTERN.test(upstream)) return upstream;
  return crypto.randomUUID();
}

/** Stamp a normalized request id on a mutable Fetch API response. */
export function stampRequestId<T extends Response>(response: T, headers: Pick<Headers, 'get'>): T {
  response.headers.set(REQUEST_ID_HEADER, resolveRequestId(headers));
  return response;
}
