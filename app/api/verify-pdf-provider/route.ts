import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveAuthConfig } from '@/lib/server/auth/config';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import {
  allowLocalNetworksEnabled,
  validateUrlForSSRF,
  validateUrlForSSRFWithPolicy,
} from '@/lib/server/ssrf-guard';
import { MINERU_CLOUD_DEFAULT_BASE } from '@/lib/pdf/constants';
import {
  consumePdfProviderVerificationRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const log = createLogger('Verify PDF Provider');
const MAX_OIDC_REQUEST_BYTES = 16 * 1024;
const MAX_CREDENTIAL_LENGTH = 8192;
const MAX_ENDPOINT_LENGTH = 2048;
const DNS_VALIDATION_TIMEOUT_MS = 5000;

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_OIDC_REQUEST_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OIDC_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function parseOidcAliDocMindRequest(value: unknown): {
  accessKeyId?: string;
  accessKeySecret?: string;
  endpoint?: string;
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.providerId !== 'alidocmind') return null;
  for (const key of ['accessKeyId', 'accessKeySecret', 'baseUrl'] as const) {
    const field = key === 'baseUrl' ? 'baseUrl' : key;
    const item = body[field];
    if (item !== undefined && typeof item !== 'string') return null;
    if (
      typeof item === 'string' &&
      item.length > (key === 'baseUrl' ? MAX_ENDPOINT_LENGTH : MAX_CREDENTIAL_LENGTH)
    ) {
      return null;
    }
  }
  return {
    ...(typeof body.accessKeyId === 'string' ? { accessKeyId: body.accessKeyId } : {}),
    ...(typeof body.accessKeySecret === 'string' ? { accessKeySecret: body.accessKeySecret } : {}),
    ...(typeof body.baseUrl === 'string' ? { endpoint: body.baseUrl.trim() } : {}),
  };
}

function normalizeAliDocMindEndpoint(value: string, allowCustomPort: boolean): URL | null {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      (!allowCustomPort && parsed.port && parsed.port !== '443')
    ) {
      return null;
    }
    return new URL(`https://${parsed.host}`);
  } catch {
    return null;
  }
}

async function validateAliDocMindEndpoint(url: URL, allowLocalNetworks: boolean): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    validateUrlForSSRFWithPolicy(url.toString(), { allowLocalNetworks }).catch(() => 'blocked'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DNS_VALIDATION_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return result === null;
}

async function oidcPost(req: NextRequest): Promise<Response> {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    if (!ownerId.startsWith('user:') || ownerId.length === 'user:'.length) {
      return ownerApiError('UNAUTHENTICATED', 401, 'Login is required', responseHeaders);
    }

    try {
      await consumePdfProviderVerificationRateLimit(ownerId);
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError(
          'RATE_LIMITED',
          429,
          'Too many PDF verification requests',
          responseHeaders,
        );
      }
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'PDF verification is unavailable',
        responseHeaders,
      );
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return ownerApiError(
        'INVALID_REQUEST',
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        error instanceof RequestBodyTooLargeError
          ? 'Request body is too large'
          : 'Invalid PDF verification request',
        responseHeaders,
      );
    }

    const request = parseOidcAliDocMindRequest(body);
    if (!request) {
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'PDF verification is unavailable for this provider',
        responseHeaders,
      );
    }

    try {
      const managed = isServerConfiguredProvider('pdf', 'alidocmind');
      const serverCredentials = managed ? resolveManagedAliDocMindCredentials() : undefined;
      if (managed && !serverCredentials) {
        return ownerApiError(
          'INTERNAL_ERROR',
          503,
          'PDF verification is unavailable',
          responseHeaders,
        );
      }
      if (!managed && (!request.accessKeyId || !request.accessKeySecret)) {
        return ownerApiError(
          'MISSING_REQUIRED_FIELD',
          400,
          'AliDocMind access credentials are required',
          responseHeaders,
        );
      }

      const allowLocalNetworks = managed && allowLocalNetworksEnabled();
      const configuredEndpoint = managed ? serverCredentials?.baseUrl : request.endpoint;
      const endpoint = configuredEndpoint
        ? normalizeAliDocMindEndpoint(configuredEndpoint, managed)
        : new URL('https://docmind-api.cn-hangzhou.aliyuncs.com');
      if (!endpoint) {
        return ownerApiError('INVALID_URL', 400, 'AliDocMind endpoint is invalid', responseHeaders);
      }
      if (!(await validateAliDocMindEndpoint(endpoint, allowLocalNetworks))) {
        return ownerApiError(
          'INVALID_URL',
          403,
          'AliDocMind endpoint is not allowed',
          responseHeaders,
        );
      }

      const { verifyAliDocMindCredentials } = await import('@/lib/pdf/alidocmind-client');
      const result = await verifyAliDocMindCredentials(
        {
          accessKeyId: serverCredentials?.accessKeyId ?? request.accessKeyId,
          accessKeySecret: serverCredentials?.accessKeySecret ?? request.accessKeySecret,
          endpoint: endpoint.host,
        },
        { allowLocalNetworks, allowCustomPort: managed },
      );
      if (!result.ok) {
        return ownerApiError(
          'INVALID_CREDENTIALS',
          400,
          'AliDocMind rejected the credentials or the verification request',
          responseHeaders,
        );
      }
      return ownerJson({ success: true, message: 'Connection successful' }, 200, responseHeaders);
    } catch {
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'PDF verification is unavailable',
        responseHeaders,
      );
    }
  });
}

export async function POST(req: NextRequest) {
  try {
    if (resolveAuthConfig().mode === 'oidc') return oidcPost(req);
  } catch {
    return apiError('INTERNAL_ERROR', 503, 'PDF verification is unavailable');
  }

  let providerId: string | undefined;
  try {
    const body = await req.json();
    providerId = body.providerId;
    const { apiKey, baseUrl, accessKeyId, accessKeySecret } = body;

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('pdf', providerId);

    // AliDocMind: verify AK/SK by issuing a lightweight authenticated probe.
    if (providerId === 'alidocmind') {
      let ak: string | undefined;
      let sk: string | undefined;
      let endpoint: string | undefined;

      if (managed) {
        // Managed: use server-owned credentials + endpoint only. Ignore any
        // client-supplied AK/SK/baseUrl.
        const serverCreds = resolveManagedAliDocMindCredentials();
        if (!serverCreds) {
          return apiError('INTERNAL_ERROR', 500, 'AliDocMind is not configured on the server');
        }
        ak = serverCreds.accessKeyId;
        sk = serverCreds.accessKeySecret;
        endpoint = serverCreds.baseUrl;
      } else {
        // Unmanaged: client credentials only — never fall back to server env.
        ak = (accessKeyId as string | undefined) || undefined;
        sk = (accessKeySecret as string | undefined) || undefined;
        endpoint = (baseUrl as string | undefined) || undefined;
        if (!ak || !sk) {
          return apiError(
            'MISSING_REQUIRED_FIELD',
            400,
            'AccessKey ID and AccessKey Secret are required for AliDocMind',
          );
        }
        // Validate a client-supplied endpoint before we sign a request to it.
        if (endpoint) {
          const ssrfError = await validateUrlForSSRF(
            endpoint.startsWith('http') ? endpoint : `https://${endpoint}`,
          );
          if (ssrfError) {
            return apiError('INVALID_URL', 403, ssrfError);
          }
        }
      }

      const { verifyAliDocMindCredentials } = await import('@/lib/pdf/alidocmind-client');
      const result = await verifyAliDocMindCredentials({
        accessKeyId: ak,
        accessKeySecret: sk,
        endpoint,
      });
      if (!result.ok) {
        return apiError('INVALID_CREDENTIALS', 400, `Authentication failed: ${result.error}`);
      }
      return apiSuccess({ message: 'Connection successful' });
    }

    // MinerU Cloud: verify by calling the cloud API with the token
    if (providerId === 'mineru-cloud') {
      const clientCloudBase = managed ? undefined : (baseUrl as string | undefined) || undefined;
      if (clientCloudBase) {
        const ssrfError = await validateUrlForSSRF(clientCloudBase);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }

      const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);
      if (!resolvedApiKey) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'API Key is required for MinerU Cloud');
      }

      const cloudBase = (
        resolvePDFBaseUrl(providerId, clientCloudBase) || MINERU_CLOUD_DEFAULT_BASE
      ).replace(/\/+$/, '');

      // Probe the batch endpoint with an empty body to verify auth
      const response = await fetch(`${cloudBase}/extract-results/batch/test-connection`, {
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
      }

      // Other responses (including 4xx for "batch not found") mean auth + connectivity works.
      // Only network errors, redirects, or 401/403 indicate a problem.
      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => '');
        return apiError(
          'INTERNAL_ERROR',
          500,
          `Authentication failed: ${text || response.statusText}`,
        );
      }

      return apiSuccess({
        message: 'Connection successful',
        status: response.status,
      });
    }

    // Self-hosted providers: verify by connecting to the base URL
    const clientBaseUrl = managed ? undefined : (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedBaseUrl = resolvePDFBaseUrl(providerId, clientBaseUrl);
    if (!resolvedBaseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);

    const headers: Record<string, string> = {};
    if (resolvedApiKey) {
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    const response = await fetch(resolvedBaseUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    // MinerU's FastAPI root returns 404 (no root route), but the server is reachable.
    // Any HTTP response (including 404) means the server is up.
    return apiSuccess({
      message: 'Connection successful',
      status: response.status,
    });
  } catch (error) {
    log.error(`PDF provider verification failed [provider=${providerId ?? 'unknown'}]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to server, please check the Base URL';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = 'Server not found, please check the Base URL';
      } else if (error.message.includes('timeout') || error.name === 'TimeoutError') {
        errorMessage = 'Connection timed out';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
