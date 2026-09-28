import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runWithUsageAttribution } from '@/lib/server/usage-attribution';
import {
  type ClassroomGenerationJobIdentity,
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
  identity: ClassroomGenerationJobIdentity,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = runWithUsageAttribution(identity, async () => {
    try {
      await markClassroomGenerationJobRunning(jobId, identity);

      const result = await generateClassroom(input, {
        baseUrl,
        ownership: identity,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, identity, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, identity, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, identity, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  });

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
