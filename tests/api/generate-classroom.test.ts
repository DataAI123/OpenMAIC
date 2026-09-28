import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  buildRequestOrigin: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  withRequestOwnerId: vi.fn(),
  consumeActionRateLimit: vi.fn(async () => undefined),
  UserApiRateLimitExceededError: class extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('User API rate limit exceeded');
    }
  },
}));

vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postGenerateClassroom(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new NextRequest('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request);
}

describe('POST /api/generate-classroom', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.after.mockReset();
    mocks.buildRequestOrigin.mockReset();
    mocks.createClassroomGenerationJob.mockReset();
    mocks.runClassroomGenerationJob.mockReset();
    mocks.withRequestOwnerId.mockReset();
    mocks.consumeActionRateLimit.mockReset().mockResolvedValue(undefined);

    mocks.buildRequestOrigin.mockReturnValue('http://localhost');
    mocks.createClassroomGenerationJob.mockResolvedValue({
      status: 'queued',
      step: 'queued',
      message: 'Classroom generation job queued',
    });
    mocks.withRequestOwnerId.mockImplementation(async (_req, handler) =>
      handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
    );
  });

  it('returns 400 when pdfContent is a string instead of the documented object', async () => {
    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent: 'plain text',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid pdfContent: expected { text: string; images: string[] }',
    });
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After when the per-user window is exhausted, before touching the job store', async () => {
    mocks.consumeActionRateLimit.mockRejectedValueOnce(new mocks.UserApiRateLimitExceededError(37));

    const res = await postGenerateClassroom({ requirement: 'Generate a class' });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('37');
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:alice', 'generate_classroom');
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate-limit store is unavailable', async () => {
    mocks.consumeActionRateLimit.mockRejectedValueOnce(
      new Error('USER_API_RATE_LIMIT_DATABASE_UNAVAILABLE'),
    );

    const res = await postGenerateClassroom({ requirement: 'Generate a class' });

    expect(res.status).toBe(503);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['missing text', { images: [] }],
    ['non-string text', { text: 123, images: [] }],
    ['missing images', { text: 'parsed text' }],
    ['non-array images', { text: 'parsed text', images: 'image.png' }],
    ['non-string image entries', { text: 'parsed text', images: ['image.png', 123] }],
  ])('returns 400 when pdfContent is %s', async (_label, pdfContent) => {
    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent,
    });

    expect(res.status).toBe(400);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('preserves the normal job submission path for valid pdfContent', async () => {
    const pdfContent = { text: 'parsed text', images: ['image-1.png'] };

    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent,
    });
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual(
      expect.objectContaining({
        success: true,
        status: 'queued',
        step: 'queued',
        pollUrl: expect.stringMatching(/^http:\/\/localhost\/api\/generate-classroom\//),
      }),
    );
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requirement: 'Generate from this PDF',
        pdfContent,
      }),
      { ownerId: 'user:alice', tenantId: 'default' },
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.runClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requirement: 'Generate from this PDF' }),
      'http://localhost',
      { ownerId: 'user:alice', tenantId: 'default' },
    );
  });
});
