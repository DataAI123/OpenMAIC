import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  consumeActionRateLimit: vi.fn(async (_ownerId: string, _routeKey: string) => undefined),
  UserApiRateLimitExceededError: class UserApiRateLimitExceededError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('User API rate limit exceeded');
    }
  },
  runPiDirectorLoop: vi.fn(async () => undefined),
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: mocks.runPiDirectorLoop }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', () => ({ isProviderKeyRequired: () => false }));
vi.mock('@/lib/config/feature-flags', () => ({
  isPiChatEnabled: () => true,
  isCoursewareReferenceEnabled: () => false,
  isPiNativeChildRuntimeEnabled: () => false,
  isPiNativeChildSpotlightEnabled: () => false,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST } from '@/app/api/chat/pi/route';

const TIMEOUT = 30_000;

function request(): NextRequest {
  return new Request('https://openmaic.example.com/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://openmaic.example.com' },
    body: JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Teach this.' }] }],
      storeState: {
        stage: { id: 'stage-1', name: 'Lesson', whiteboard: [] },
        scenes: [],
        currentSceneId: undefined,
        mode: 'playback',
        whiteboardOpen: false,
      },
      config: {
        agentIds: ['teacher-1'],
        agentConfigs: [
          {
            id: 'teacher-1',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Teach.',
            priority: 10,
            avatar: '',
            color: '#3366ff',
            allowedActions: [],
          },
        ],
      },
    }),
  }) as unknown as NextRequest;
}

describe('POST /api/chat/pi OIDC identity and cost boundary', () => {
  beforeEach(() => {
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
    mocks.consumeActionRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.runPiDirectorLoop.mockClear();
    mocks.resolveModel.mockReset().mockResolvedValue({
      model: {},
      apiKey: 'byok-key',
      providerId: 'openai',
      modelInfo: undefined,
      thinkingConfig: undefined,
    });
  });

  it(
    'charges the chat_pi window before starting the director loop',
    async () => {
      const req = request();
      const response = await POST(req);

      expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(req, expect.any(Function));
      expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:alice', 'chat_pi');
      expect(mocks.runPiDirectorLoop).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    },
    TIMEOUT,
  );

  it(
    'returns 429 with Retry-After and never starts the loop when the window is exhausted',
    async () => {
      mocks.consumeActionRateLimit.mockRejectedValueOnce(
        new mocks.UserApiRateLimitExceededError(9),
      );
      const response = await POST(request());

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('9');
      await expect(response.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
      expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    'fails closed when the rate-limit store is unavailable',
    async () => {
      mocks.consumeActionRateLimit.mockRejectedValueOnce(new Error('no database'));
      const response = await POST(request());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
      expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    'does not start the loop when the owner boundary rejects the request',
    async () => {
      mocks.withRequestOwnerId.mockResolvedValue(
        Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 }),
      );

      await expect(POST(request())).resolves.toHaveProperty('status', 401);
      expect(mocks.consumeActionRateLimit).not.toHaveBeenCalled();
      expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );
});
