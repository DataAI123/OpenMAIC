import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  buildRequestOrigin: vi.fn(),
  readClassroomGenerationJob: vi.fn(),
  withRequestOwnerId: vi.fn(),
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  isValidClassroomJobId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  readClassroomGenerationJob: mocks.readClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('GET /api/generate-classroom/[jobId]', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.buildRequestOrigin.mockReset().mockReturnValue('http://localhost');
    mocks.readClassroomGenerationJob.mockReset();
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_req, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
  });

  it('returns progress only after looking up the job in the authenticated owner and tenant scope', async () => {
    mocks.readClassroomGenerationJob.mockResolvedValue({
      id: 'job-1',
      ownerId: 'user:alice',
      tenantId: 'default',
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      message: 'Classroom generation completed',
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
      inputSummary: {
        requirementPreview: 'lesson',
        hasPdf: false,
        pdfTextLength: 0,
        pdfImageCount: 0,
      },
      scenesGenerated: 1,
      result: { classroomId: 'class-1', url: 'http://localhost/classroom/class-1', scenesCount: 1 },
    });
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');

    const response = await GET(
      new Request('http://localhost/api/generate-classroom/job-1') as unknown as NextRequest,
      { params: Promise.resolve({ jobId: 'job-1' }) },
    );

    expect(mocks.readClassroomGenerationJob).toHaveBeenCalledWith('job-1', {
      ownerId: 'user:alice',
      tenantId: 'default',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual({
      classroomId: 'class-1',
      url: 'http://localhost/classroom/class-1',
      scenesCount: 1,
    });
    expect(body).not.toHaveProperty('ownerId');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('returns the same not-found response for a job not owned by this principal', async () => {
    mocks.readClassroomGenerationJob.mockResolvedValue(null);
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');

    const response = await GET(
      new Request('http://localhost/api/generate-classroom/job-1') as unknown as NextRequest,
      { params: Promise.resolve({ jobId: 'job-1' }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Classroom generation job not found',
    });
  });
});
