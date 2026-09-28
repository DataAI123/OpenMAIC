import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { documentArtifactToParsedPdfContent, extractDocument } from '@/lib/document';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { resolveAuthConfig } from '@/lib/server/auth/config';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { ownerApiError } from '@/lib/server/agent-runtime/route-response';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import {
  consumeActionRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

// The OIDC owner boundary reads the database-backed session and the extractor
// may reach the local network, so this route needs the Node runtime.
export const runtime = 'nodejs';

const log = createLogger('Parse PDF');

// The declared multipart body may exceed the file itself (boundary headers and
// sibling fields); allow a fixed slack over the file cap so a legitimately
// sized upload is never rejected for framing overhead.
const MAX_OIDC_MULTIPART_BODY_BYTES = MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES + 1024 * 1024;

async function handlePost(req: NextRequest, oidcMode: boolean) {
  let pdfFileName: string | undefined;
  let resolvedProviderId: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for PDF upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data, got "${contentType}"`,
      );
    }

    // Reject an oversized body before it is buffered for multipart parsing. The
    // declared length is the cheap early exit; the file-size check below is the
    // authoritative one. Both caps are OIDC-only so legacy behavior is unchanged.
    if (oidcMode) {
      const declaredLength = Number(req.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_OIDC_MULTIPART_BODY_BYTES) {
        return apiError('INVALID_REQUEST', 413, 'PDF upload is too large.');
      }
    }

    const formData = await req.formData();
    const pdfFile = formData.get('pdf') as File | null;
    const providerId = formData.get('providerId') as PDFProviderId | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!pdfFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No PDF file provided');
    }

    if (oidcMode && pdfFile.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
      return apiError('INVALID_REQUEST', 413, 'PDF upload is too large.');
    }

    // providerId is required from the client — no server-side store to fall back to
    const effectiveProviderId = providerId || ('unpdf' as PDFProviderId);
    pdfFileName = pdfFile?.name;
    resolvedProviderId = effectiveProviderId;

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('pdf', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      apiKey: resolvePDFApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
      baseUrl: resolvePDFBaseUrl(effectiveProviderId, clientBaseUrl),
    };

    // Convert PDF to buffer
    const arrayBuffer = await pdfFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Route the existing PDF API through the document extraction boundary.
    const artifact = await extractDocument({
      buffer,
      fileName: pdfFile.name,
      fileSize: pdfFile.size,
      mimeType: 'application/pdf',
      config,
    });
    const result = documentArtifactToParsedPdfContent(artifact);

    // Add file metadata
    const resultWithMetadata: ParsedPdfContent = {
      ...result,
      metadata: {
        ...result.metadata,
        pageCount: result.metadata?.pageCount ?? 0, // Ensure pageCount is always a number
        fileName: pdfFile.name,
        fileSize: pdfFile.size,
      },
    };

    return apiSuccess({ data: resultWithMetadata });
  } catch (error) {
    if (oidcMode) {
      log.error('PDF parsing failed for an OIDC request');
    } else {
      log.error(
        `PDF parsing failed [provider=${resolvedProviderId ?? 'unknown'}, file="${pdfFileName ?? 'unknown'}"]:`,
        error,
      );
    }
    return apiError(
      'PARSE_FAILED',
      500,
      oidcMode
        ? 'The PDF could not be parsed. Please try again later.'
        : error instanceof Error
          ? error.message
          : 'Unknown error',
    );
  }
}

export async function POST(req: NextRequest) {
  let oidcMode: boolean;
  try {
    oidcMode = resolveAuthConfig().mode === 'oidc';
  } catch {
    return apiError('INTERNAL_ERROR', 503, 'PDF parsing is unavailable.');
  }
  if (!oidcMode) return handlePost(req, false);

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    // Parsed content is user-specific: never let any response — including the
    // rate-limit and owner-boundary rejections — be cached.
    responseHeaders.set('Cache-Control', 'private, no-store');
    try {
      await consumeActionRateLimit(ownerId, 'parse_pdf');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError('RATE_LIMITED', 429, 'Too many PDF parse requests', responseHeaders);
      }
      return ownerApiError('INTERNAL_ERROR', 503, 'Rate limiting is unavailable', responseHeaders);
    }
    const response = await handlePost(req, true);
    const headers = new Headers(response.headers);
    responseHeaders.forEach((value, name) => headers.set(name, value));
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
