import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// GET /api/skills/[id] streams a skill as a zip: built-ins are public, but an
// owner skill must only download for its owner. This guards the by-id read on
// the zip route (which the JSON detail route does not cover) against an
// existence oracle — a foreign owner and an absent id must answer identically.
const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  withRequestOwnerId: vi.fn(),
  findUserSkill: vi.fn(),
  buildBuiltinSkillZip: vi.fn(),
  buildOpenClawSkillZip: vi.fn(),
  buildUserSkillZip: vi.fn(),
  isSafeSkillId: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/user-skills', () => ({
  findUserSkill: mocks.findUserSkill,
}));
vi.mock('@/lib/server/skill-export', () => ({
  buildBuiltinSkillZip: mocks.buildBuiltinSkillZip,
  buildOpenClawSkillZip: mocks.buildOpenClawSkillZip,
  buildUserSkillZip: mocks.buildUserSkillZip,
  isSafeSkillId: mocks.isSafeSkillId,
}));

import { GET } from '@/app/api/skills/[id]/route';

const get = (id: string, requestId?: string) =>
  GET(
    new NextRequest(`http://localhost/api/skills/${id}`, {
      headers: requestId ? { 'x-request-id': requestId } : undefined,
    }),
    {
      params: Promise.resolve({ id }),
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.isSafeSkillId.mockReturnValue(true);
  // No built-in matches, so the owner-skill branch is the one under test.
  mocks.buildBuiltinSkillZip.mockResolvedValue(null);
  mocks.withRequestOwnerId.mockImplementation(
    async (
      _req: NextRequest,
      handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    ) => handler('user:u1', new Headers()),
  );
});

describe('GET /api/skills/:id (skill zip)', () => {
  it('downloads an owner skill only via the resolved owner partition', async () => {
    mocks.findUserSkill.mockResolvedValue({
      id: 'usk_1',
      name: 'usk_1',
      title: 'Mine',
      description: 'd',
      content: '# body',
    });
    mocks.buildUserSkillZip.mockResolvedValue(Buffer.from('zipbytes'));

    const response = await get('usk_1');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    // The store lookup is bound to the authenticated owner, never the raw id.
    expect(mocks.findUserSkill).toHaveBeenCalledWith('usk_1', 'user:u1');
  });

  it('correlates a public built-in zip response', async () => {
    mocks.buildOpenClawSkillZip.mockResolvedValue(Buffer.from('zipbytes'));

    const response = await get('openmaic', 'builtin-skill-download');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('builtin-skill-download');
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(mocks.withRequestOwnerId).not.toHaveBeenCalled();
  });

  it('correlates the runtime gate before owner resolution', async () => {
    mocks.runtimeConfigured = false;

    const response = await get('openmaic', 'skills-runtime-disabled');

    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBe('skills-runtime-disabled');
    expect(mocks.withRequestOwnerId).not.toHaveBeenCalled();
  });

  it('answers a foreign owner and an absent id with the identical plain 404', async () => {
    // findUserSkill returns null for "not found" AND "belongs to someone else",
    // so both callers see one indistinguishable response — no existence oracle.
    mocks.findUserSkill.mockResolvedValue(null);

    const foreign = await get('usk_foreign');
    const absent = await get('usk_absent');

    const foreignBody = await foreign.text();
    const absentBody = await absent.text();

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreignBody).toBe('Not found');
    expect(absentBody).toBe(foreignBody);
    expect(mocks.buildUserSkillZip).not.toHaveBeenCalled();
  });

  it('rejects an unsafe skill id before touching the owner store', async () => {
    mocks.isSafeSkillId.mockReturnValue(false);

    const response = await get('../etc/passwd', 'unsafe-skill-id');

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('unsafe-skill-id');
    expect(mocks.withRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.findUserSkill).not.toHaveBeenCalled();
  });
});
