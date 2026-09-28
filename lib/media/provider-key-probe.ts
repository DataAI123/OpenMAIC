/**
 * The provider key probe: the one contract a capability route may use to ask a
 * provider to verify a BYOK key without generating anything.
 *
 * The route keeps everything that is not vendor knowledge — identity, rate
 * limiting, the pinned transport's lifetime, and the deadline — and resolves
 * the vendor half (the fixed read-only endpoint, the accepted base URL, and the
 * operator-facing copy) through the modality catalog. A route therefore never
 * names a vendor, and that half stays on the adapter.
 */

/**
 * The pinned transport the route owns. Narrower than `fetch` on purpose: a
 * probe may only issue the request it was handed, and may not close the
 * transport, because the route's `finally` owns that.
 */
export interface ProviderKeyProbeTransport {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

/**
 * A probe's verdict. A redirect is its own outcome rather than an upstream
 * error because the pinned transport asks for `redirect: 'manual'`: a `3xx` is
 * a deliberate refusal that must surface as one, never be followed.
 */
export type ProviderKeyProbeOutcome = 'ok' | 'redirect' | 'invalid-key' | 'upstream-error';

export interface ProviderKeyProbeResult {
  outcome: ProviderKeyProbeOutcome;
  /** Operator-facing text; never carries upstream response metadata. */
  message: string;
}

export interface ProviderKeyProbeInput {
  apiKey: string;
  transport: ProviderKeyProbeTransport;
  /** Caller-owned deadline, forwarded unchanged. */
  signal: AbortSignal;
}

export interface ProviderKeyProbe {
  /** Message for a missing or oversized key. */
  readonly missingKeyMessage: string;
  /** Message for a client-supplied base URL outside the accepted form. */
  readonly rejectedBaseUrlMessage: string;
  /** Whether a client-supplied `x-base-url` value may address the probe. */
  isBaseUrlAllowed(headerValue: string | null): boolean;
  probe(input: ProviderKeyProbeInput): Promise<ProviderKeyProbeResult>;
}
