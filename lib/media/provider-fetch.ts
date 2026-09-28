/**
 * Connect-time SSRF hardening for image and video provider requests.
 *
 * The `/api/generate/image` and `/api/generate/video` routes validate a
 * client-supplied BYOK `baseUrl` once (via `validateUrlForSSRF`), but the
 * adapter is the one that opens the socket afterwards. That split leaves two
 * windows the URL check cannot cover: DNS rebinding (the public name
 * re-resolves to an internal address between the guard and connect) and a `3xx`
 * answer that redirects to one. When the caller supplied the base URL we
 * therefore run the provider request through the same pinned-dispatcher +
 * per-hop redirect revalidation the TTS/ASR transport uses
 * ({@link audioProviderFetch}), under the identical `ALLOW_LOCAL_NETWORKS`
 * policy the route already applied — so the self-hosting escape hatch keeps
 * working while the connect-time window closes.
 *
 * Server-managed base URLs (env / provider default) are trusted operator
 * config, never validated by the route, and are left on the plain global
 * `fetch` so a managed localhost ComfyUI/Lemonade stays reachable without the
 * opt-in flag. The flag is only set for the request whose URL the route
 * actually treated as untrusted input.
 */
import { audioProviderFetch } from '@/lib/server/audio-provider-fetch';

/** Options forwarded to the pinned transport when connections are guarded. */
export interface ImageProviderFetchOptions {
  /**
   * Treat a `3xx` as a hard failure instead of following it, while still
   * pinning the connect-time DNS. Adapters that set `redirect: 'manual'` /
   * `'error'` themselves (to keep an `Authorization` header from crossing
   * origins) pass this so the escape-hatch intent survives pinning.
   */
  rejectRedirects?: boolean;
}

/** Video shares the image seam's option shape and semantics verbatim. */
export type VideoProviderFetchOptions = ImageProviderFetchOptions;

/**
 * Issue one provider request, pinning the connection only when the route marked
 * the base URL as client-supplied BYOK input. Media-agnostic: both the image
 * and video adapters call this through their type-named wrappers below.
 */
function providerFetch(
  config: { pinSsrfConnections?: boolean },
  input: string | URL,
  init?: RequestInit,
  options: ImageProviderFetchOptions = {},
): Promise<Response> {
  return config.pinSsrfConnections
    ? audioProviderFetch(input, init, { rejectRedirects: options.rejectRedirects })
    : fetch(input, init);
}

/**
 * Image-provider entry point. See {@link providerFetch}.
 */
export function imageProviderFetch(
  config: { pinSsrfConnections?: boolean },
  input: string | URL,
  init?: RequestInit,
  options: ImageProviderFetchOptions = {},
): Promise<Response> {
  return providerFetch(config, input, init, options);
}

/**
 * Video-provider entry point. See {@link providerFetch}. Video adapters submit
 * an async job then poll for it; every leg (submit, poll, and any provider-hosted
 * result/task-status URL) should route through this so the connect-time window
 * stays closed for the whole lifecycle of a BYOK request.
 */
export function videoProviderFetch(
  config: { pinSsrfConnections?: boolean },
  input: string | URL,
  init?: RequestInit,
  options: VideoProviderFetchOptions = {},
): Promise<Response> {
  return providerFetch(config, input, init, options);
}
