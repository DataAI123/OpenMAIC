import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  listComfyuiWorkflows: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/media/comfyui-workflows', () => ({
  listComfyuiWorkflows: mocks.listComfyuiWorkflows,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: mocks.loggerError }) }));

import { GET } from '@/app/api/comfyui-workflows/route';

describe('GET /api/comfyui-workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listComfyuiWorkflows.mockResolvedValue([
      { id: 'comfyui-workflow.json', name: 'Workflow' },
    ]);
    mocks.withRequestOwnerId.mockImplementation(async (_request, handler) =>
      handler('user:alice', new Headers({ 'Set-Cookie': 'openmaic_owner=legacy-owner' })),
    );
  });

  it('requires the shared owner/session boundary and returns uncached static metadata', async () => {
    const request = new NextRequest('https://openmaic.example.com/api/comfyui-workflows');
    const response = await GET(request);

    expect(mocks.withRequestOwnerId).toHaveBeenCalledOnce();
    expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(request, expect.any(Function));
    expect(await response.json()).toEqual({
      workflows: [{ id: 'comfyui-workflow.json', name: 'Workflow' }],
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=legacy-owner');
  });

  it('returns a no-store error response if listing unexpectedly fails', async () => {
    mocks.listComfyuiWorkflows.mockRejectedValueOnce(new Error('directory unavailable'));

    const response = await GET(
      new NextRequest('https://openmaic.example.com/api/comfyui-workflows'),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=legacy-owner');
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });
});
