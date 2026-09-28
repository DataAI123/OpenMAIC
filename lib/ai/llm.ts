/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, JSONValue, LanguageModel, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import { getModelMetadataKey } from './model-metadata';
import { getCanonicalModelId } from './model-aliases';
import type { ProviderId, ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@/lib/ai/thinking-config';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Native providers (OpenAI/Anthropic/Google) are mapped to providerOptions.
// OpenAI-compatible providers are injected by the providers.ts fetch wrapper.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  thinking?: ThinkingCapability;
}

/** Provider/model → thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(getModelMetadataKey(provider.id, model.id), {
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Model ID → thinking capability for IDs that are unique across providers. */
const UNIQUE_MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const counts = new Map<string, number>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    }
  }

  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      if (counts.get(model.id) === 1) {
        map.set(model.id, {
          thinking: model.capabilities?.thinking,
        });
      }
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { mode: 'disabled', enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

function getAnthropicEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = pickThinkingEffort(thinking, config);
  if (!effort || effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

function normalizeProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic.messages' && modelId?.startsWith('MiniMax-')) return 'minimax';
  if (provider === 'amazon-bedrock') return 'bedrock';
  if (provider in PROVIDERS) return provider;
  const prefix = provider.split('.')[0];
  return prefix in PROVIDERS ? prefix : undefined;
}

function getModelProviderId(params: GenerateTextParams | StreamTextParams): string | undefined {
  const m = params.model;
  if (!m || typeof m !== 'object' || !('provider' in m)) return undefined;
  const provider = (m as { provider?: string }).provider;
  const modelId = 'modelId' in m ? (m as { modelId?: string }).modelId : undefined;
  return normalizeProviderId(provider, modelId);
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  providerId: string | undefined,
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const lookupModelId = providerId ? getCanonicalModelId(providerId, modelId) : modelId;
  const info = providerId
    ? MODEL_THINKING_MAP.get(getModelMetadataKey(providerId, lookupModelId))
    : UNIQUE_MODEL_THINKING_MAP.get(lookupModelId);
  if (!info?.thinking) return undefined; // model has no thinking capability
  const thinking = info.thinking;
  if (thinking.control === 'none') return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.requestAdapter) {
    case 'openai': {
      const effort = pickThinkingEffort(thinking, config);
      return effort ? { openai: { reasoningEffort: effort } } : undefined;
    }

    case 'anthropic': {
      const buildAnthropicOptions = (
        options: Record<string, JSONValue | undefined>,
      ): ProviderOptions => ({
        anthropic: options,
      });

      if (mode === 'disabled' && thinking.toggleable !== false) {
        return buildAnthropicOptions({ thinking: { type: 'disabled' } });
      }

      if (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') {
        const budget = pickThinkingBudget(thinking, config);
        return budget === undefined
          ? undefined
          : buildAnthropicOptions({ thinking: { type: 'enabled', budgetTokens: budget } });
      }

      const effort = getAnthropicEffort(thinking, config);
      if (!effort) return undefined;

      if (thinking.anthropicThinking?.type === 'adaptive') {
        return buildAnthropicOptions({
          thinking: { type: 'adaptive' },
          effort,
        });
      }

      const manualEffort = effort === 'xhigh' ? 'max' : effort;
      const budget = thinking.anthropicThinking?.budgetByEffort?.[manualEffort];
      if (!budget) return undefined;
      return buildAnthropicOptions({
        thinking: { type: 'enabled', budgetTokens: budget },
        effort: manualEffort,
      });
    }

    case 'google': {
      if (thinking.control === 'level') {
        const level = pickThinkingLevel(thinking, config);
        return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : undefined;
      }

      const budget = pickThinkingBudget(thinking, config);
      if (budget === undefined) return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }

    default:
      // OpenAI-compatible providers are injected in providers.ts fetch wrapper.
      return undefined;
  }
}

/**
 * Resolve providerOptions the way callLLM / streamLLM resolve them internally.
 *
 * There are no production callers left: every server-side call goes through the
 * wrappers (a lint rule enforces it), and they inject provider options
 * themselves. Kept exported because it is the only way to inspect that mapping
 * from the outside, which the SDK-integration tests do.
 */
export function resolveThinkingProviderOptions(
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): ProviderOptions | undefined {
  if (!thinkingConfig) return undefined;
  if (typeof model !== 'object' || !('modelId' in model)) return undefined;
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const provider = 'provider' in model ? (model as { provider?: string }).provider : undefined;
  return buildThinkingProviderOptions(
    normalizeProviderId(provider, modelId),
    modelId,
    thinkingConfig,
  );
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);
  const providerId = getModelProviderId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(providerId, modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  return params;
}

/**
 * Options for LLM call retry on validation failure.
 * This is separate from the AI SDK's built-in maxRetries (which handles network/5xx errors).
 */
export interface LLMRetryOptions {
  /** Max retry attempts when validate() fails or the response is empty (default: 0 = no retry) */
  retries?: number;
  /** Custom validation function. Return true to accept the result, false to retry.
   *  Default: checks that response text is non-empty. */
  validate?: (text: string) => boolean;
}

const DEFAULT_VALIDATE = (text: string) => text.trim().length > 0;

// ---------------------------------------------------------------------------
// Usage capture
//
// Every server-side LLM call funnels through callLLM/streamLLM, so usage is
// recorded here in one place. Fire-and-forget: failures never affect generation.
// The fs-backed storage is imported dynamically so llm.ts stays safe to bundle
// wherever it's transitively imported.
// ---------------------------------------------------------------------------

function buildUsageMeta(params: GenerateTextParams | StreamTextParams, source: string) {
  const rawModelId = getModelId(params);
  const providerId = getModelProviderId(params) ?? 'unknown';
  const modelId = getCanonicalModelId(providerId, rawModelId);
  return { source, providerId, modelId, modelString: `${providerId}:${modelId}` };
}

/** Record one call's usage. Never throws. */
function recordUsageSafe(
  rawUsage: unknown,
  meta: { source: string; providerId: string; modelId: string; modelString: string },
  quotaEstimatedTokens?: number,
): void {
  void (async () => {
    try {
      const { normalizeUsage } = await import('@/lib/usage/normalize');
      const { recordUsage } = await import('@/lib/server/usage-storage');
      await recordUsage({
        kind: 'llm',
        source: meta.source,
        providerId: meta.providerId,
        modelId: meta.modelId,
        modelString: meta.modelString,
        usage: normalizeUsage(rawUsage as never),
        ...(quotaEstimatedTokens != null ? { quotaEstimatedTokens } : {}),
      });
    } catch (err) {
      log.warn('Usage capture failed (ignored):', err);
    }
  })();
}

interface PersonalQuotaHooks {
  abortSignal: AbortSignal;
  prepareStep: (event: unknown) => Promise<unknown>;
  onStepFinish: (event: unknown) => Promise<void>;
  finish: () => Promise<void>;
  fail: () => Promise<void>;
}

function getStepContextWindow(model: unknown): number {
  if (!model || typeof model !== 'object') {
    throw new Error('PERSONAL_LLM_QUOTA_MODEL_CONTEXT_UNKNOWN');
  }
  const info = model as { provider?: unknown; modelId?: unknown };
  const rawProvider = typeof info.provider === 'string' ? info.provider : undefined;
  const modelId = typeof info.modelId === 'string' ? info.modelId : undefined;
  const providerId = normalizeProviderId(rawProvider, modelId);
  if (!providerId || !modelId) throw new Error('PERSONAL_LLM_QUOTA_MODEL_CONTEXT_UNKNOWN');
  const canonicalId = getCanonicalModelId(providerId, modelId);
  const modelInfo = PROVIDERS[providerId as ProviderId]?.models.find(
    (candidate) => candidate.id === canonicalId || candidate.id === modelId,
  );
  const contextWindow = modelInfo?.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || !contextWindow || contextWindow <= 0) {
    throw new Error('PERSONAL_LLM_QUOTA_MODEL_CONTEXT_UNKNOWN');
  }
  return contextWindow;
}

function isPersonalQuotaError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (typeof current !== 'object' && typeof current !== 'string') continue;
    seen.add(current);
    if (typeof current === 'string') {
      if (current.includes('PERSONAL_LLM_QUOTA_') || current.includes('PERSONAL_LLM_MONTHLY_')) {
        return true;
      }
      continue;
    }

    const details = current as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (
      details.code === 'PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED' ||
      (typeof details.message === 'string' &&
        (details.message.includes('PERSONAL_LLM_QUOTA_') ||
          details.message.includes('PERSONAL_LLM_MONTHLY_')))
    ) {
      return true;
    }
    pending.push(details.cause);
    if (Array.isArray(details.errors)) pending.push(...details.errors);
  }
  return false;
}

/**
 * Reserve the model's full context window before each provider step. This is a
 * provider-independent upper bound for that step; excess is released when the
 * actual usage arrives. A new reservation is acquired by prepareStep before a
 * tool loop can call the model again.
 */
async function createPersonalQuotaHooks(
  params: GenerateTextParams | StreamTextParams,
  meta: { source: string; providerId: string; modelId: string; modelString: string },
  leaseAbort = new AbortController(),
): Promise<PersonalQuotaHooks | undefined> {
  if (process.env.OPENMAIC_AUTH_MODE?.trim() !== 'oidc') return undefined;
  const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
  const attribution = currentUsageAttribution();
  const ownerId = attribution?.ownerId;
  // Same server-resolved attribution that names the owner also names the tenant,
  // so a user who belongs to two tenants reserves against two separate monthly
  // budgets. Absent a tenant the engine falls back to the controlled `default`.
  const tenantId = attribution?.tenantId;
  if (!ownerId?.startsWith('user:')) {
    throw new Error('PERSONAL_LLM_QUOTA_REQUIRES_AUTHENTICATED_USER');
  }
  const { renewPersonalLlmTokenReservation, reservePersonalLlmTokens, settlePersonalLlmTokens } =
    await import('@/lib/server/personal-llm-quota');

  const record = params as Record<string, unknown>;
  const callerPrepareStep = record.prepareStep as ((event: unknown) => unknown) | undefined;
  const callerOnStepFinish = record.onStepFinish as ((event: unknown) => unknown) | undefined;
  const callerAbortSignal = record.abortSignal as AbortSignal | undefined;
  const abortSignal = callerAbortSignal
    ? AbortSignal.any([callerAbortSignal, leaseAbort.signal])
    : leaseAbort.signal;
  let active: Awaited<ReturnType<typeof reservePersonalLlmTokens>> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatRunning = false;

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  const startHeartbeat = (reservationId: string) => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (heartbeatRunning || active?.id !== reservationId) return;
      heartbeatRunning = true;
      void renewPersonalLlmTokenReservation(reservationId)
        .catch((error: unknown) => {
          leaseAbort.abort(
            error instanceof Error
              ? new Error('PERSONAL_LLM_QUOTA_RESERVATION_LEASE_LOST', { cause: error })
              : new Error('PERSONAL_LLM_QUOTA_RESERVATION_LEASE_LOST'),
          );
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, 60_000);
    heartbeatTimer.unref?.();
  };

  const settle = async (actualTokens?: number) => {
    if (!active) return undefined;
    const reservation = active;
    // If a provider omits usage on a completed step, charge the reservation's
    // full upper bound rather than letting an unmeasured call be free.
    const estimated = actualTokens === undefined;
    const chargedTokens = actualTokens ?? reservation.reservedTokens;
    await settlePersonalLlmTokens(reservation.id, chargedTokens);
    active = undefined;
    stopHeartbeat();
    return { chargedTokens, estimated };
  };

  return {
    abortSignal,
    prepareStep: async (event) => {
      const prepared = callerPrepareStep ? await callerPrepareStep(event) : undefined;
      if (active) throw new Error('PERSONAL_LLM_QUOTA_STEP_RESERVATION_NOT_SETTLED');
      const stepModel =
        prepared && typeof prepared === 'object' && 'model' in prepared
          ? (prepared as { model?: unknown }).model
          : (event as { model?: unknown } | null)?.model;
      const stepReservation = getStepContextWindow(stepModel ?? params.model);
      active = tenantId
        ? await reservePersonalLlmTokens(ownerId, stepReservation, undefined, tenantId)
        : await reservePersonalLlmTokens(ownerId, stepReservation);
      startHeartbeat(active.id);
      return prepared;
    },
    onStepFinish: async (event) => {
      const usage = (event as { usage?: unknown } | null)?.usage;
      const { hasBillableTokens, normalizeUsage } = await import('@/lib/usage/normalize');
      const normalized = normalizeUsage(usage as never);
      const inputTokens = Number.isFinite(normalized.inputTokens) ? normalized.inputTokens : 0;
      const cacheTokens =
        (Number.isFinite(normalized.cacheReadTokens) ? normalized.cacheReadTokens : 0) +
        (Number.isFinite(normalized.cacheCreationTokens) ? normalized.cacheCreationTokens : 0);
      const outputTokens = Number.isFinite(normalized.outputTokens) ? normalized.outputTokens : 0;
      const actualTokens = Math.max(inputTokens, cacheTokens) + outputTokens;
      const hasMeasuredUsage = hasBillableTokens(normalized);
      const settlement = await settle(
        hasMeasuredUsage && Number.isSafeInteger(actualTokens) && actualTokens >= 0
          ? actualTokens
          : undefined,
      );
      recordUsageSafe(usage, meta, settlement?.estimated ? settlement.chargedTokens : undefined);
      if (callerOnStepFinish) await callerOnStepFinish(event);
    },
    finish: async () => {
      try {
        const settlement = await settle();
        if (settlement?.estimated) recordUsageSafe(undefined, meta, settlement.chargedTokens);
      } catch (error) {
        stopHeartbeat();
        throw error;
      }
    },
    fail: async () => {
      try {
        const settlement = await settle();
        if (settlement?.estimated) recordUsageSafe(undefined, meta, settlement.chargedTokens);
      } catch (error) {
        stopHeartbeat();
        throw error;
      }
    },
  };
}

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any>> {
  const maxAttempts = (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let quotaHooks: PersonalQuotaHooks | undefined;
    try {
      // Resolve effective thinking config: per-call > global env > undefined
      const effectiveThinking = thinking ?? getGlobalThinkingConfig();
      const injectedParams = injectProviderOptions(params, effectiveThinking);
      const usageMeta = buildUsageMeta(params, source);
      quotaHooks = await createPersonalQuotaHooks(params, usageMeta);
      const hookedParams = quotaHooks
        ? ({
            ...injectedParams,
            // The SDK's internal retries are invisible to our quota boundary.
            // callLLM's explicit retry loop can retry, with a fresh reservation.
            maxRetries: 0,
            abortSignal: quotaHooks.abortSignal,
            prepareStep: quotaHooks.prepareStep,
            onStepFinish: quotaHooks.onStepFinish,
          } as T)
        : injectedParams;

      // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
      // can read the config and inject vendor-specific body params for
      // OpenAI-compatible providers.
      const result = await thinkingContext.run(effectiveThinking, () => generateText(hookedParams));
      await quotaHooks?.finish();

      // Record before validating: every attempt that got this far was billed,
      // including one that fails validation below and one that is handed back
      // after the retries are exhausted. Recording on the success path only
      // would drop both.
      //
      // `usage` is the LAST step only; on a multi-step tool run (`stopWhen`)
      // every earlier step would go unaccounted. `totalUsage` aggregates across
      // steps and equals `usage` for a single-step call. Mirrors streamLLM,
      // which already prefers the aggregate.
      if (!quotaHooks) recordUsageSafe(result.totalUsage ?? result.usage, usageMeta);

      // Validate result (only when retries are configured)
      if (validate && !validate(result.text)) {
        log.warn(
          `[${source}] Validation failed (attempt ${attempt}/${maxAttempts}), ${attempt < maxAttempts ? 'retrying...' : 'giving up'}`,
        );
        lastResult = result;
        continue;
      }

      return result;
    } catch (error) {
      await quotaHooks?.fail();
      lastError = error;

      if (attempt < maxAttempts && !isPersonalQuotaError(error)) {
        log.warn(`[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`, error);
        continue;
      }
      break;
    }
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult) return lastResult;
  throw lastError;
}

/**
 * Unified wrapper around `streamText`.
 *
 * Returns the same StreamTextResult.
 *
 * @param params - Same parameters as AI SDK's `streamText`
 * @param source - A short label for log grouping
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export function streamLLM<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StreamTextResult<any, any> {
  // Resolve effective thinking config and wrap in thinkingContext
  const effectiveThinking = thinking ?? getGlobalThinkingConfig();

  // Wrap onFinish to capture usage when the stream completes, preserving any
  // caller-supplied onFinish. totalUsage aggregates across steps.
  const usageMeta = buildUsageMeta(params, source);
  const quotaEnabled = process.env.OPENMAIC_AUTH_MODE?.trim() === 'oidc';
  const quotaAbortController = new AbortController();
  const callerAbortSignal = (params as Record<string, unknown>).abortSignal as
    | AbortSignal
    | undefined;
  const quotaAbortSignal = callerAbortSignal
    ? AbortSignal.any([callerAbortSignal, quotaAbortController.signal])
    : quotaAbortController.signal;
  const quotaHooksPromise = quotaEnabled
    ? createPersonalQuotaHooks(params, usageMeta, quotaAbortController)
    : Promise.resolve(undefined);
  const callerOnFinish = (params as Record<string, unknown>).onFinish as
    | ((event: { totalUsage?: unknown; usage?: unknown }) => void | Promise<void>)
    | undefined;
  const callerOnError = (params as Record<string, unknown>).onError as
    | ((event: unknown) => void | Promise<void>)
    | undefined;
  const callerOnAbort = (params as Record<string, unknown>).onAbort as
    | ((event: unknown) => void | Promise<void>)
    | undefined;
  const wrappedParams = {
    ...params,
    ...(quotaEnabled ? { maxRetries: 0 } : {}),
    ...(quotaEnabled
      ? {
          abortSignal: quotaAbortSignal,
          prepareStep: async (event: unknown) => (await quotaHooksPromise)?.prepareStep(event),
          onStepFinish: async (event: unknown) => (await quotaHooksPromise)?.onStepFinish(event),
          onError: async (event: unknown) => {
            await (await quotaHooksPromise)?.fail();
            if (callerOnError) await callerOnError(event);
          },
          onAbort: async (event: unknown) => {
            await (await quotaHooksPromise)?.fail();
            if (callerOnAbort) await callerOnAbort(event);
          },
        }
      : {}),
    onFinish: async (event: { totalUsage?: unknown; usage?: unknown }) => {
      const hooks = quotaEnabled ? await quotaHooksPromise : undefined;
      await hooks?.finish();
      if (!hooks) recordUsageSafe(event.totalUsage ?? event.usage, usageMeta);
      if (callerOnFinish) await callerOnFinish(event);
    },
  } as T;

  const injectedParams = injectProviderOptions(wrappedParams, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}
