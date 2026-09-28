import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Node #39 wiring invariant: every stateless action route admitted under OIDC
// must consume its own per-user fixed-window key before touching the model or
// provider. The behavioural 429/503/Retry-After contract is locked by
// `quiz-grade-owner-gate.test.ts` (the limiter is mocked there); this suite
// keeps the remaining routes honest about calling the engine with the exact
// route key the widening migrations (0010 onward) whitelist.

const WIRING: Array<[routeFile: string, routeKey: string]> = [
  ['app/api/chat/route.ts', 'api_chat'],
  ['app/api/chat/pi/route.ts', 'chat_pi'],
  ['app/api/generate/scene-content/route.ts', 'generate_scene_content'],
  ['app/api/generate/scene-actions/route.ts', 'generate_scene_actions'],
  ['app/api/generate/scene-outlines-stream/route.ts', 'generate_scene_outlines_stream'],
  ['app/api/generate/agent-profiles/route.ts', 'generate_agent_profiles'],
  ['app/api/generate/voice/route.ts', 'generate_voice'],
  ['app/api/quiz-grade/route.ts', 'quiz_grade'],
  ['app/api/pbl/v2/instructor/route.ts', 'pbl_v2_instructor'],
  ['app/api/pbl/v2/evaluate/route.ts', 'pbl_v2_evaluate'],
  ['app/api/pbl/v2/open-task/route.ts', 'pbl_v2_open_task'],
  ['app/api/pbl/v2/simulator/route.ts', 'pbl_v2_simulator'],
  ['app/api/pbl/v2/task/update/route.ts', 'pbl_v2_task_update'],
  ['app/api/extract-document/route.ts', 'extract_document'],
  ['app/api/transcription/route.ts', 'transcription'],
  ['app/api/classroom/route.ts', 'classroom_store'],
  ['app/api/generate-classroom/route.ts', 'generate_classroom'],
  ['app/api/web-search/route.ts', 'web_search'],
];

describe('action routes consume their per-user rate-limit key', () => {
  it('each opened action handler awaits consumeActionRateLimit with its exact key', async () => {
    for (const [routeFile, routeKey] of WIRING) {
      const source = await readFile(path.join(process.cwd(), routeFile), 'utf8');
      expect(
        source,
        `${routeFile} must await consumeActionRateLimit(ownerId, '${routeKey}')`,
      ).toContain(`await consumeActionRateLimit(ownerId, '${routeKey}')`);
      expect(source).toContain(`if (error instanceof UserApiRateLimitExceededError)`);
      // Routes answer the 429 with their own helper shape: most use `fail(...)`,
      // while relay-style handlers (transcription, extract-document) use
      // `ownerApiError(...)`. Formatting may wrap the arguments, so match the
      // RATE_LIMITED/429 pair with whitespace tolerance.
      expect(source).toMatch(/'RATE_LIMITED',\s+429/);
    }
  });
});
