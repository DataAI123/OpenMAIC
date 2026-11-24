export type GenerationFailure = {
  statusCode?: number;
  errorCode?: string;
};

export type GenerationFailureCategory =
  | 'login-required'
  | 'tenant-required'
  | 'permission-denied'
  | 'auth-unavailable'
  | 'provider-auth-failed'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'provider-unavailable'
  | 'internal-error'
  | 'invalid-request'
  | 'unknown';

/** Classify stable API envelopes before showing generation-specific copy. */
export function classifyGenerationFailure(failure: GenerationFailure): GenerationFailureCategory {
  const { statusCode, errorCode } = failure;

  if (statusCode === 401 && errorCode === 'LOGIN_REQUIRED') return 'login-required';
  if (statusCode === 403 && errorCode === 'TENANT_REQUIRED') return 'tenant-required';
  if (errorCode === 'AUTH_UNAVAILABLE') return 'auth-unavailable';
  if (errorCode === 'FORBIDDEN') return 'permission-denied';
  if (errorCode === 'MISSING_API_KEY' || errorCode === 'INVALID_CREDENTIALS') {
    return 'provider-auth-failed';
  }
  if (statusCode === 429 || errorCode === 'RATE_LIMITED') return 'rate-limited';
  if (errorCode && /QUOTA.*(EXCEEDED|LIMIT)|(?:EXCEEDED|LIMIT).*QUOTA/i.test(errorCode)) {
    return 'quota-exceeded';
  }
  if (errorCode === 'INTERNAL_ERROR') return 'internal-error';
  if (errorCode === 'UPSTREAM_ERROR' || (statusCode !== undefined && statusCode >= 500)) {
    return 'provider-unavailable';
  }
  if (errorCode === 'INVALID_REQUEST' || errorCode === 'MISSING_REQUIRED_FIELD') {
    return 'invalid-request';
  }
  // Server owner/auth boundaries use stable error codes, while older or
  // intermediary responses may omit one. Keep a bare 401/403 out of the
  // provider-credential path; upstream credential failures carry explicit
  // MISSING_API_KEY / INVALID_CREDENTIALS codes above.
  if (statusCode === 401) return 'login-required';
  if (statusCode === 403) return 'permission-denied';
  return 'unknown';
}

/** Do not replay stable policy/client failures; retry transient failures or empty success payloads. */
export function shouldRetryGenerationResult(
  result: GenerationFailure & { success: boolean },
  hasPayload: boolean,
): boolean {
  const category = classifyGenerationFailure(result);
  if (
    category === 'login-required' ||
    category === 'tenant-required' ||
    category === 'permission-denied' ||
    category === 'auth-unavailable' ||
    category === 'provider-auth-failed' ||
    category === 'rate-limited' ||
    category === 'quota-exceeded' ||
    category === 'invalid-request'
  ) {
    return false;
  }
  if (result.statusCode !== undefined && result.statusCode >= 400 && result.statusCode < 500) {
    return false;
  }
  return !result.success || !hasPayload;
}
