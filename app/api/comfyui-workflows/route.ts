/**
 * GET /api/comfyui-workflows
 *
 * Returns a list of ComfyUI workflow JSON files found in the Next.js
 * public/ directory, with display names derived from their filenames.
 * Discovery logic lives in lib/media/comfyui-workflows.ts and is shared
 * with the ComfyUI image adapter, so the list returned here is always
 * exactly what the adapter will accept as a workflow id.
 *
 * Response: { workflows: Array<{ id: string; name: string }> }
 */

import type { NextRequest } from 'next/server';

import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { listComfyuiWorkflows } from '@/lib/media/comfyui-workflows';
import { createLogger } from '@/lib/logger';

const log = createLogger('ComfyUI Workflows API');

export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (_ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    try {
      return ownerJson({ workflows: await listComfyuiWorkflows() }, 200, responseHeaders);
    } catch (error) {
      log.error('Failed to list workflows:', error);
      return ownerApiError('INTERNAL_ERROR', 500, 'Failed to list workflows', responseHeaders);
    }
  });
}
