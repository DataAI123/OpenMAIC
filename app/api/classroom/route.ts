import { type NextRequest } from 'next/server';
import { validateScene } from '@openmaic/dsl';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  ClassroomAlreadyExistsError,
  CLASSROOM_ID_MAX_ATTEMPTS,
  generateClassroomId,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createLogger } from '@/lib/logger';
import {
  withRequestOwnerId,
  type RequestOwnerIdentity,
} from '@/lib/server/agent-runtime/with-owner';
import {
  consumeActionRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const log = createLogger('Classroom API');

function describeSceneIssue(issue: { path: string; message: string }): string {
  const at = issue.path && issue.path !== '' ? issue.path : '/';
  return `${at}: ${issue.message}`;
}

async function handlePost(request: NextRequest, identity: RequestOwnerIdentity) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    const body = await request.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    if (typeof stage !== 'object' || Array.isArray(stage)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom stage');
    }
    if (!Array.isArray(scenes)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom scenes: must be an array',
      );
    }

    // The scenes must already have the shape the slide DSL declares (id,
    // stageId, title, order, type and a content payload bound to that type).
    // Rejecting malformed scenes here keeps garbage out of storage instead of
    // letting viewers choke on it later.
    for (const [index, scene] of scenes.entries()) {
      const result = validateScene(scene);
      if (!result.valid) {
        const first = result.errors[0];
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `Invalid classroom scene at index ${index}`,
          first ? describeSceneIssue(first) : undefined,
        );
      }
    }

    const baseUrl = buildRequestOrigin(request);

    // Sanitize every HTML-bearing string in the payload before it reaches
    // storage: stored slide HTML is restricted to the formatting vocabulary
    // the renderer produces (see sanitize-scene-content.ts).
    const safeStage = sanitizeSceneContent(stage);
    const safeScenes = sanitizeSceneContent(scenes);

    // The storage id is ALWAYS server-generated. A caller-supplied stage.id is
    // ignored: ids are public share-URL segments, so accepting one would let
    // any visitor name — and therefore attempt to replace — an existing
    // classroom. The generated id becomes the stage id and every scene's
    // stageId so the persisted document is internally consistent.
    let persisted: Awaited<ReturnType<typeof persistClassroom>> | undefined;
    for (let attempt = 0; attempt < CLASSROOM_ID_MAX_ATTEMPTS; attempt += 1) {
      const id = generateClassroomId();

      // Defence in depth: the generator only emits allowlisted characters, but
      // an id must never be joined into a filesystem path unasserted.
      if (!isValidClassroomId(id)) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
      }

      try {
        persisted = await persistClassroom(
          {
            id,
            ...identity,
            stage: { ...safeStage, id },
            scenes: safeScenes.map((scene) => ({ ...scene, stageId: id })),
          },
          baseUrl,
          { exclusive: true },
        );
        break;
      } catch (error) {
        if (!(error instanceof ClassroomAlreadyExistsError)) {
          throw error;
        }
        // Astronomically unlikely with a 10-character id: pick a fresh id and
        // retry a bounded number of times rather than clobbering the
        // incumbent classroom.
      }
    }

    if (!persisted) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 409, 'Classroom id collision');
    }

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function POST(request: NextRequest) {
  return withRequestOwnerId(request, async (ownerId, responseHeaders, identity) => {
    const fail = (code: 'RATE_LIMITED' | 'INTERNAL_ERROR', status: number, message: string) => {
      const response = apiError(code, status, message);
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    };
    try {
      await consumeActionRateLimit(ownerId, 'classroom_store');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return fail('RATE_LIMITED', 429, 'Too many classroom saves');
      }
      return fail('INTERNAL_ERROR', 503, 'Rate limiting is unavailable');
    }
    const response = await handlePost(request, identity ?? { ownerId });
    responseHeaders.forEach((value, name) => response.headers.append(name, value));
    return response;
  });
}

export async function GET(request: NextRequest) {
  return withRequestOwnerId(request, async (ownerId, responseHeaders, identity) => {
    const isOidcUser = ownerId.startsWith('user:');
    if (isOidcUser) responseHeaders.set('Cache-Control', 'private, no-store');
    const finish = (response: Response) => {
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    };

    try {
      const id = request.nextUrl.searchParams.get('id');

      if (!id) {
        return finish(
          apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing required parameter: id'),
        );
      }

      if (!isValidClassroomId(id)) {
        return finish(apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id'));
      }

      const classroom = await readClassroom(id);
      if (!classroom) {
        return finish(apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found'));
      }

      // OIDC classroom reads are owner- and tenant-private until a separate
      // public-sharing policy is approved. Return the same 404 for absent and
      // foreign resources so the route does not confirm that an id exists.
      if (
        isOidcUser &&
        (!identity?.tenantId ||
          classroom.ownerId !== ownerId ||
          classroom.tenantId !== identity.tenantId)
      ) {
        return finish(apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found'));
      }

      // Classroom files written before this change were stored unsanitized and
      // cannot be migrated on deployments we do not control. Run the same
      // sanitizer over the payload on the way out so already-stored content
      // is cleaned at the single serve choke point too.
      return finish(apiSuccess({ classroom: sanitizeSceneContent(classroom) }));
    } catch (error) {
      log.error(
        `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
        error,
      );
      return finish(
        apiError(
          API_ERROR_CODES.INTERNAL_ERROR,
          500,
          'Failed to retrieve classroom',
          isOidcUser ? undefined : error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
}
