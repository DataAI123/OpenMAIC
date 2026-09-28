import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  markClassroomGenerationJobFailed: vi.fn(),
  markClassroomGenerationJobRunning: vi.fn(),
  markClassroomGenerationJobSucceeded: vi.fn(),
  updateClassroomGenerationJobProgress: vi.fn(),
}));

vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: mocks.generateClassroom,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  markClassroomGenerationJobFailed: mocks.markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning: mocks.markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded: mocks.markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress: mocks.updateClassroomGenerationJobProgress,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('classroom generation job runner identity', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.generateClassroom.mockReset();
    mocks.markClassroomGenerationJobFailed.mockReset();
    mocks.markClassroomGenerationJobRunning.mockReset();
    mocks.markClassroomGenerationJobSucceeded.mockReset();
    mocks.updateClassroomGenerationJobProgress.mockReset();
  });

  it('carries the persisted owner and tenant through worker updates and LLM usage attribution', async () => {
    const identity = { ownerId: 'user:alice', tenantId: 'default' };
    const expectedResult = {
      id: 'classroom-1',
      url: 'https://example.test/classroom/classroom-1',
      stage: {},
      scenes: [],
      scenesCount: 0,
      createdAt: '2026-09-24T00:00:00.000Z',
    };
    mocks.generateClassroom.mockImplementation(async (_input, options) => {
      const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
      expect(currentUsageAttribution()).toEqual(identity);
      await options.onProgress({
        step: 'initializing',
        progress: 5,
        message: 'Initializing',
        scenesGenerated: 0,
      });
      return expectedResult;
    });
    const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');

    await runClassroomGenerationJob(
      'job-1',
      { requirement: 'lesson' },
      'https://example.test',
      identity,
    );

    expect(mocks.markClassroomGenerationJobRunning).toHaveBeenCalledWith('job-1', identity);
    expect(mocks.updateClassroomGenerationJobProgress).toHaveBeenCalledWith(
      'job-1',
      identity,
      expect.objectContaining({ progress: 5 }),
    );
    expect(mocks.markClassroomGenerationJobSucceeded).toHaveBeenCalledWith(
      'job-1',
      identity,
      expectedResult,
    );
    expect(mocks.markClassroomGenerationJobFailed).not.toHaveBeenCalled();
  });
});
