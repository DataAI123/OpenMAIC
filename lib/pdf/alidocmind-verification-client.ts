import { Readable } from 'node:stream';
import { OpenApiUtil } from '@alicloud/openapi-core';
import { fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from 'undici';
import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
type SdkRuntime = {
  extendsParameters?: { headers?: Record<string, string>; queries?: Record<string, string> };
};
type OpenApiParams = {
  action: string;
  version: string;
  protocol: string;
  pathname: string;
  method: string;
  authType: string;
  bodyType: string;
  reqBodyType: string;
  style?: string;
};
type OpenApiRequest = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  stream?: Readable;
  hostMap?: Record<string, string>;
  endpointOverride?: string;
};

type SpiContext = {
  request: {
    headers: Record<string, string>;
    query: Record<string, string>;
    stream?: Readable;
    pathname: string;
    protocol: string;
    method: string;
    [key: string]: unknown;
  };
  configuration: { endpoint: string; [key: string]: unknown };
  response?: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: Readable;
    deserializedBody?: unknown;
    [key: string]: unknown;
  };
};

/**
 * Install a one-request, DNS-pinned transport for the AliDocMind SDK.
 * Signing and response decoding remain in the installed SDK SPI implementation.
 */
export function createPinnedAliDocMindVerificationClient<T extends object>(
  client: T,
  options: { allowLocalNetworks?: boolean; allowCustomPort?: boolean } = {},
): T {
  const sdk = client as T & {
    _spi: {
      modifyConfiguration(context: SpiContext, attributes: unknown): Promise<void>;
      modifyRequest(context: SpiContext, attributes: unknown): Promise<void>;
      modifyResponse(context: SpiContext, attributes: unknown): Promise<void>;
    };
    _attributeMap: unknown;
    getRpcHeaders(): Record<string, string>;
    _globalParameters?: { headers?: Record<string, string>; queries?: Record<string, string> };
    _userAgent: string;
    _protocol: string;
    _method: string;
    _endpoint: string;
    _endpointRule: string;
    _endpointMap: Record<string, string>;
    _regionId: string;
    _endpointType: string;
    _network: string;
    _suffix: string;
    _productId: string;
    _credential: unknown;
    _signatureVersion: string;
    _signatureAlgorithm: string;
  };

  const executeClient = sdk as unknown as {
    execute(
      params: OpenApiParams,
      request: OpenApiRequest,
      runtime: SdkRuntime,
    ): Promise<{ headers?: Record<string, string>; statusCode?: number; body?: unknown }>;
  };

  executeClient.execute = async (
    params: OpenApiParams,
    request: OpenApiRequest,
    runtime: SdkRuntime,
  ) => {
    const globalParameters = sdk._globalParameters;
    const extendedParameters = runtime.extendsParameters;
    const context: SpiContext = {
      request: {
        headers: {
          ...globalParameters?.headers,
          ...extendedParameters?.headers,
          ...request.headers,
          ...sdk.getRpcHeaders(),
        },
        query: { ...globalParameters?.queries, ...extendedParameters?.queries, ...request.query },
        body: request.body,
        stream: request.stream,
        hostMap: request.hostMap,
        pathname: params.pathname,
        productId: sdk._productId,
        action: params.action,
        version: params.version,
        protocol: sdk._protocol || params.protocol,
        method: sdk._method || params.method,
        authType: params.authType,
        bodyType: params.bodyType,
        reqBodyType: params.reqBodyType,
        style: params.style,
        credential: sdk._credential,
        signatureVersion: sdk._signatureVersion,
        signatureAlgorithm: sdk._signatureAlgorithm,
        userAgent: OpenApiUtil.getUserAgent(sdk._userAgent),
      },
      configuration: {
        regionId: sdk._regionId,
        endpoint: request.endpointOverride || sdk._endpoint,
        endpointRule: sdk._endpointRule,
        endpointMap: sdk._endpointMap,
        endpointType: sdk._endpointType,
        network: sdk._network,
        suffix: sdk._suffix,
      },
    };
    const attributes = sdk._attributeMap ?? { attributes: {}, key: {} };

    await sdk._spi.modifyConfiguration(context, attributes);
    await sdk._spi.modifyRequest(context, attributes);

    const endpoint = new URL(`${context.request.protocol}://${context.configuration.endpoint}`);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.port && endpoint.port !== '443' && !options.allowCustomPort) ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error('AliDocMind verification endpoint is not an allowed HTTPS origin');
    }
    const signedHost = context.request.headers.host;
    if (
      typeof signedHost !== 'string' ||
      signedHost.toLowerCase() !== endpoint.host.toLowerCase()
    ) {
      throw new Error('AliDocMind verification endpoint does not match its signed host');
    }

    endpoint.pathname = context.request.pathname || '/';
    for (const [key, value] of Object.entries(context.request.query ?? {})) {
      if (value !== undefined && value !== null) endpoint.searchParams.append(key, String(value));
    }

    const dispatcher = createValidatedDispatcher({
      allowLocalNetworks: options.allowLocalNetworks ?? false,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      connectTimeout: 5_000,
    });
    try {
      const body = context.request.stream as Readable | undefined;
      const response = await undiciFetch(endpoint, {
        method: context.request.method,
        headers: context.request.headers,
        body: body as never,
        ...(body ? { duplex: 'half' as const } : {}),
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('AliDocMind verification endpoint returned a redirect');
      }

      const bytes = await readBoundedResponse(response);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      context.response = {
        statusCode: response.status,
        headers: responseHeaders,
        body: Readable.from(bytes),
      };
      await sdk._spi.modifyResponse(context, attributes);
      return {
        headers: context.response.headers,
        statusCode: context.response.statusCode,
        body: context.response.deserializedBody,
      };
    } finally {
      await (dispatcher as Dispatcher).close();
    }
  };

  return client;
}

async function readBoundedResponse(response: UndiciResponse): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('AliDocMind verification response exceeded its limit');
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('AliDocMind verification response exceeded its limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
