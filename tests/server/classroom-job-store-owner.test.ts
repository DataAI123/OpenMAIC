import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('classroom generation job ownership', () => {
  let jobsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    jobsDir = await mkdtemp(path.join(os.tmpdir(), 'openmaic-classroom-jobs-'));
    vi.stubEnv('OPENMAIC_CLASSROOM_JOBS_DIR', jobsDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(jobsDir, { recursive: true, force: true });
  });

  it('only returns a job to the same owner and tenant', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const owner = { ownerId: 'user:alice', tenantId: 'default' };
    await store.createClassroomGenerationJob('job-1', { requirement: 'lesson' }, owner);

    await expect(store.readClassroomGenerationJob('job-1', owner)).resolves.toMatchObject({
      ownerId: owner.ownerId,
      tenantId: owner.tenantId,
    });
    await expect(
      store.readClassroomGenerationJob('job-1', { ownerId: 'user:bob', tenantId: 'default' }),
    ).resolves.toBeNull();
    await expect(
      store.readClassroomGenerationJob('job-1', { ownerId: owner.ownerId, tenantId: 'other' }),
    ).resolves.toBeNull();
  });

  it('prevents worker status updates from crossing owner or tenant boundaries', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const owner = { ownerId: 'user:alice', tenantId: 'default' };
    await store.createClassroomGenerationJob('job-2', { requirement: 'lesson' }, owner);

    await expect(
      store.markClassroomGenerationJobRunning('job-2', {
        ownerId: 'user:bob',
        tenantId: 'default',
      }),
    ).rejects.toThrow('Classroom generation job owner mismatch');
    await expect(store.markClassroomGenerationJobRunning('job-2', owner)).resolves.toMatchObject({
      status: 'running',
      ownerId: owner.ownerId,
    });
  });

  it('keeps legacy jobs partitioned by their anonymous owner', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob(
      'job-3',
      { requirement: 'lesson' },
      {
        ownerId: 'anon:browser-a',
      },
    );

    await expect(
      store.readClassroomGenerationJob('job-3', { ownerId: 'anon:browser-a' }),
    ).resolves.toMatchObject({ ownerId: 'anon:browser-a' });
    await expect(
      store.readClassroomGenerationJob('job-3', { ownerId: 'anon:browser-b' }),
    ).resolves.toBeNull();
  });

  it('rejects identities without an owner or an OIDC tenant', async () => {
    const store = await import('@/lib/server/classroom-job-store');

    await expect(
      store.createClassroomGenerationJob(
        'job-4',
        { requirement: 'lesson' },
        {
          ownerId: 'public:anonymous',
        },
      ),
    ).rejects.toThrow('Classroom generation job requires an owner');
    await expect(
      store.createClassroomGenerationJob(
        'job-5',
        { requirement: 'lesson' },
        {
          ownerId: 'user:alice',
        },
      ),
    ).rejects.toThrow('Authenticated classroom generation job requires a tenant');
  });

  it('does not replace an existing job if a generated id collides', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob(
      'job-collision',
      { requirement: 'first' },
      {
        ownerId: 'anon:browser-a',
      },
    );

    await expect(
      store.createClassroomGenerationJob(
        'job-collision',
        { requirement: 'second' },
        {
          ownerId: 'anon:browser-b',
        },
      ),
    ).rejects.toThrow();
    await expect(
      store.readClassroomGenerationJob('job-collision', { ownerId: 'anon:browser-a' }),
    ).resolves.toMatchObject({
      ownerId: 'anon:browser-a',
      inputSummary: { requirementPreview: 'first' },
    });
  });

  it('does not allow a status patch to replace the persisted task identity', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const owner = { ownerId: 'user:alice', tenantId: 'default' };
    await store.createClassroomGenerationJob('job-6', { requirement: 'lesson' }, owner);

    const updated = await store.updateClassroomGenerationJob('job-6', owner, {
      status: 'running',
      ownerId: 'user:bob',
      tenantId: 'other',
    } as Parameters<typeof store.updateClassroomGenerationJob>[2]);

    expect(updated).toMatchObject(owner);
  });
});
