import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  // `totalUsage` is optional here so a single-step case can omit it: multi-step
  // runs report the aggregate there and callLLM prefers it over `usage`.
  generateText: vi.fn(
    async (
      params: unknown,
    ): Promise<{ text: string; params: unknown; usage?: unknown; totalUsage?: unknown }> => ({
      text: 'ok',
      params,
    }),
  ),
  streamText: vi.fn(),
}));

const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  hasBillableTokens: vi.fn((usage: unknown) => {
    if (!usage || typeof usage !== 'object') return false;
    const row = usage as Record<string, unknown>;
    return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(
      (key) => typeof row[key] === 'number' && row[key] > 0,
    );
  }),
  recordUsage: vi.fn(async () => undefined),
}));

const quotaMock = vi.hoisted(() => ({
  ownerId: 'user:alice' as string | undefined,
  renew: vi.fn(async () => undefined),
  reserve: vi.fn(async (_ownerId: string, reservedTokens: number) => ({
    id: `reservation-${reservedTokens}`,
    ownerId: 'user:alice',
    periodStart: '2026-09-01',
    reservedTokens,
  })),
  settle: vi.fn(async () => undefined),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

vi.mock('@/lib/usage/normalize', () => ({
  normalizeUsage: usageMock.normalizeUsage,
  hasBillableTokens: usageMock.hasBillableTokens,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: usageMock.recordUsage,
}));

vi.mock('@/lib/server/usage-attribution', () => ({
  currentUsageAttribution: () =>
    quotaMock.ownerId ? { ownerId: quotaMock.ownerId, tenantId: 'default' } : undefined,
}));

vi.mock('@/lib/server/personal-llm-quota', () => ({
  renewPersonalLlmTokenReservation: quotaMock.renew,
  reservePersonalLlmTokens: quotaMock.reserve,
  settlePersonalLlmTokens: quotaMock.settle,
}));

import { callLLM, streamLLM } from '@/lib/ai/llm';

describe('LLM thinking provider options', () => {
  beforeEach(() => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');
    quotaMock.ownerId = 'user:alice';
    quotaMock.renew.mockClear();
    aiMock.generateText.mockReset();
    aiMock.generateText.mockImplementation(async (params: unknown) => ({ text: 'ok', params }));
    aiMock.streamText.mockReset();
    usageMock.normalizeUsage.mockClear();
    usageMock.hasBillableTokens.mockClear();
    usageMock.recordUsage.mockClear();
    quotaMock.reserve.mockClear();
    quotaMock.settle.mockClear();
    quotaMock.reserve.mockImplementation(async (_ownerId, reservedTokens) => ({
      id: `reservation-${reservedTokens}`,
      ownerId: 'user:alice',
      periodStart: '2026-09-01',
      reservedTokens,
    }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('sends GPT-5.6 max reasoning effort through OpenAI provider options', async () => {
    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as unknown as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'max' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openai: {
            reasoningEffort: 'max',
          },
        },
      }),
    );
  });

  it('sends max reasoning effort for the GPT-5.6 Sol model ID alias', async () => {
    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6-sol',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'max' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: 'gpt-5.6-sol' }),
        providerOptions: {
          openai: {
            reasoningEffort: 'max',
          },
        },
      }),
    );
  });

  it('aggregates GPT-5.6 Sol alias usage under the canonical model ID', async () => {
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6-sol',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openai',
          modelId: 'gpt-5.6',
          modelString: 'openai:gpt-5.6',
        }),
      );
    });
  });

  it('attributes Amazon Bedrock SDK usage to the Bedrock provider', async () => {
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await callLLM(
      {
        model: {
          provider: 'amazon-bedrock',
          modelId: 'us.anthropic.claude-sonnet-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'bedrock',
          modelId: 'us.anthropic.claude-sonnet-5',
          modelString: 'bedrock:us.anthropic.claude-sonnet-5',
        }),
      );
    });
  });

  it('records the aggregate usage of a multi-step tool run, not the last step', async () => {
    // `usage` on a multi-step run (`stopWhen`) is the final step alone; every
    // earlier step's tokens live only in `totalUsage`.
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 3, outputTokens: 4 },
      totalUsage: { inputTokens: 30, outputTokens: 40 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { inputTokens: 30, outputTokens: 40 } }),
      );
    });
  });

  it('records every attempt when a retry is configured, not just the accepted one', async () => {
    // Both attempts hit the provider and were billed; the first one just failed
    // validation. Recording on the success path only would drop it.
    aiMock.generateText
      .mockResolvedValueOnce({
        text: '',
        params: undefined,
        totalUsage: { inputTokens: 7, outputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: 'ok',
        params: undefined,
        totalUsage: { inputTokens: 9, outputTokens: 2 },
      });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      { retries: 1 },
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledTimes(2);
    });
    // Nested objectContaining: the recorded usage may carry normalised
    // zero-valued fields alongside the two this test set.
    expect(usageMock.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 0 }),
      }),
    );
    expect(usageMock.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 2 }),
      }),
    );
  });

  it('records the last attempt even when every attempt fails validation', async () => {
    // `Once` twice rather than a persistent implementation: beforeEach only
    // clears calls, so a lingering mockResolvedValue would leak into later tests.
    const failed = {
      text: '',
      params: undefined,
      totalUsage: { inputTokens: 5, outputTokens: 0 },
    };
    aiMock.generateText.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      { retries: 1 },
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledTimes(2);
    });
  });

  // Defensive: ai@6's GenerateTextResult always carries `totalUsage`, so this
  // shape is not one the current SDK produces — the fallback exists so a future
  // result shape without the aggregate degrades to the final step instead of
  // recording nothing.
  it('falls back to the single-step usage when no aggregate is reported', async () => {
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { inputTokens: 3, outputTokens: 4 } }),
      );
    });
  });

  it('reserves each OIDC model step before the provider call and settles actual tokens', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as {
        prepareStep: (event: unknown) => Promise<unknown>;
        onStepFinish: (event: unknown) => Promise<void>;
      };
      await callbacks.prepareStep({
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
      });
      await callbacks.onStepFinish({ usage: { inputTokens: 12, outputTokens: 7 } });
      return {
        text: 'ok',
        params,
        totalUsage: { inputTokens: 12, outputTokens: 7 },
      };
    });

    await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'quota-test',
    );

    expect(quotaMock.reserve).toHaveBeenCalledOnce();
    expect(quotaMock.reserve).toHaveBeenCalledWith('user:alice', 1_050_000);
    expect(quotaMock.settle).toHaveBeenCalledWith('reservation-1050000', 19);
    await vi.waitFor(() => expect(usageMock.recordUsage).toHaveBeenCalledOnce());
  });

  it('requires a server-resolved OIDC owner before invoking the provider', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    quotaMock.ownerId = undefined;

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
          prompt: 'hi',
        } as Parameters<typeof callLLM>[0],
        'quota-test',
      ),
    ).rejects.toThrow('PERSONAL_LLM_QUOTA_REQUIRES_AUTHENTICATED_USER');

    expect(aiMock.generateText).not.toHaveBeenCalled();
    expect(quotaMock.reserve).not.toHaveBeenCalled();
  });

  it('does not retry or reach the provider after monthly quota admission is denied', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    quotaMock.reserve.mockRejectedValueOnce(new Error('PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED'));
    let providerStarted = false;
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as { prepareStep: (event: unknown) => Promise<unknown> };
      await callbacks.prepareStep({
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
      });
      providerStarted = true;
      return { text: 'must not run', params };
    });

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
          prompt: 'hi',
        } as Parameters<typeof callLLM>[0],
        'quota-denied-test',
        { retries: 2 },
      ),
    ).rejects.toThrow('PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED');

    expect(providerStarted).toBe(false);
    expect(aiMock.generateText).toHaveBeenCalledOnce();
    expect(quotaMock.reserve).toHaveBeenCalledOnce();
  });

  it('uses a separate context reservation for every tool-loop model step', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    let reservationNumber = 0;
    quotaMock.reserve.mockImplementation(async (_ownerId, reservedTokens) => {
      reservationNumber += 1;
      return {
        id: `step-${reservationNumber}`,
        ownerId: 'user:alice',
        periodStart: '2026-09-01',
        reservedTokens,
      };
    });
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as {
        prepareStep: (event: unknown) => Promise<unknown>;
        onStepFinish: (event: unknown) => Promise<void>;
      };
      for (const tokens of [5, 11]) {
        await callbacks.prepareStep({
          model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
        });
        await callbacks.onStepFinish({
          usage: { inputTokens: tokens - 2, outputTokens: 2 },
        });
      }
      return { text: 'ok', params, totalUsage: { inputTokens: 12, outputTokens: 4 } };
    });

    await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
        prompt: 'hi',
        tools: { next: {} },
      } as unknown as Parameters<typeof callLLM>[0],
      'quota-loop-test',
    );

    expect(quotaMock.reserve).toHaveBeenCalledTimes(2);
    expect(quotaMock.settle).toHaveBeenNthCalledWith(1, 'step-1', 5);
    expect(quotaMock.settle).toHaveBeenNthCalledWith(2, 'step-2', 11);
  });

  it('charges the reserved context ceiling when a successful step omits usage', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as {
        prepareStep: (event: unknown) => Promise<unknown>;
        onStepFinish: (event: unknown) => Promise<void>;
      };
      await callbacks.prepareStep({
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
      });
      await callbacks.onStepFinish({ usage: { inputTokens: 0, outputTokens: 0 } });
      return { text: 'ok', params, totalUsage: { inputTokens: 0, outputTokens: 0 } };
    });

    await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'quota-unmeasured-test',
    );

    expect(quotaMock.settle).toHaveBeenCalledWith('reservation-1050000', 1_050_000);
    await vi.waitFor(() =>
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ quotaEstimatedTokens: 1_050_000 }),
      ),
    );
  });

  it('settles the reserved ceiling and records an estimate when a provider call fails', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as { prepareStep: (event: unknown) => Promise<unknown> };
      await callbacks.prepareStep({
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
      });
      throw new Error('provider unavailable');
    });

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
          prompt: 'hi',
        } as Parameters<typeof callLLM>[0],
        'quota-provider-error-test',
      ),
    ).rejects.toThrow('provider unavailable');

    expect(quotaMock.settle).toHaveBeenCalledWith('reservation-1050000', 1_050_000);
    await vi.waitFor(() =>
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ quotaEstimatedTokens: 1_050_000 }),
      ),
    );
  });

  it('fails closed for OIDC models without a catalog context ceiling', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    aiMock.generateText.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as { prepareStep: (event: unknown) => Promise<unknown> };
      await callbacks.prepareStep({
        model: { provider: 'custom-openai', modelId: 'unlisted-model' },
      });
      return { text: 'must not reach provider', params };
    });

    await expect(
      callLLM(
        {
          model: { provider: 'custom-openai', modelId: 'unlisted-model' },
          prompt: 'hi',
        } as Parameters<typeof callLLM>[0],
        'quota-test',
      ),
    ).rejects.toThrow('PERSONAL_LLM_QUOTA_MODEL_CONTEXT_UNKNOWN');
    expect(quotaMock.reserve).not.toHaveBeenCalled();
  });

  it('reserves and settles streaming model steps and disables invisible SDK retries', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    const streamResult = { textStream: 'stream' };
    aiMock.streamText.mockReturnValueOnce(streamResult);

    const result = streamLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
        prompt: 'hi',
      } as Parameters<typeof streamLLM>[0],
      'quota-stream-test',
    );
    const wrapped = aiMock.streamText.mock.calls[0]?.[0] as {
      maxRetries: number;
      prepareStep: (event: unknown) => Promise<unknown>;
      onStepFinish: (event: unknown) => Promise<void>;
      onFinish: (event: unknown) => Promise<void>;
    };

    await wrapped.prepareStep({
      model: { provider: 'openai.responses', modelId: 'gpt-5.6' },
    });
    await wrapped.onStepFinish({ usage: { inputTokens: 9, outputTokens: 4 } });
    await wrapped.onFinish({ totalUsage: { inputTokens: 9, outputTokens: 4 } });

    expect(result).toBe(streamResult);
    expect(wrapped.maxRetries).toBe(0);
    expect(quotaMock.reserve).toHaveBeenCalledWith('user:alice', 1_050_000);
    expect(quotaMock.settle).toHaveBeenCalledWith('reservation-1050000', 13);
  });

  it('sends Claude Haiku 4.5 thinking budget without effort', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-haiku-4-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', budgetTokens: 4096 },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'enabled', budgetTokens: 4096 },
          },
        },
      }),
    );
    const params = aiMock.generateText.mock.calls[0]?.[0] as {
      providerOptions?: { anthropic?: Record<string, unknown> };
    };
    expect(params.providerOptions?.anthropic).not.toHaveProperty('effort');
  });

  it('sends MiniMax M3 thinking disablement through Anthropic provider options', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'MiniMax-M3',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'disabled' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'disabled' },
          },
        },
      }),
    );
  });

  it('coerces disabled thinking to the lowest supported effort for Claude Fable 5', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-fable-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'disabled' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' },
            effort: 'low',
          },
        },
      }),
    );
  });

  it('sends xhigh reasoning effort for Claude 5 models', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-opus-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'xhigh' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' },
            effort: 'xhigh',
          },
        },
      }),
    );
  });
});
