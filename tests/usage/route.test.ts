import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/usage/route';
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: vi.fn(async (_request, handler) => handler('user:alice', new Headers())),
}));

vi.mock('@/lib/server/usage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-storage')>();
  return {
    ...actual,
    readUsageRecords: vi.fn(),
  };
});

describe('GET /api/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readUsageRecords).mockResolvedValue([]);
    vi.mocked(withRequestOwnerId).mockImplementation(async (_request, handler) =>
      handler('user:alice', new Headers()),
    );
  });

  it('does not add cache detail fields again to displayed token totals', async () => {
    const record: UsageRecord = {
      id: '1',
      createdAt: Date.UTC(2026, 5, 29),
      kind: 'llm',
      source: 'chat',
      providerId: 'openai',
      modelId: 'gpt-x',
      modelString: 'openai:gpt-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 0,
      unit: 'token',
    };
    vi.mocked(readUsageRecords).mockResolvedValueOnce([record]);

    const response = await GET(new NextRequest('http://localhost/api/usage'));
    const body = await response.json();

    expect(body.totals.llmTokens).toBe(120);
    expect(body.byModel[0].totalTokens).toBe(120);
    expect(body.byModel[0].cacheReadTokens).toBe(30);
    expect(body.byModel[0].cacheCreationTokens).toBe(10);
    expect(readUsageRecords).toHaveBeenCalledWith({ ownerId: 'user:alice' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('includes conservative quota estimates in totals and reports them separately', async () => {
    const record: UsageRecord = {
      id: 'estimate',
      createdAt: Date.UTC(2026, 5, 29),
      kind: 'llm',
      source: 'chat',
      providerId: 'openai',
      modelId: 'gpt-x',
      modelString: 'openai:gpt-x',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      quotaEstimatedTokens: 1_050_000,
    };
    vi.mocked(readUsageRecords).mockResolvedValueOnce([record]);

    const response = await GET(new NextRequest('http://localhost/api/usage'));
    const body = await response.json();

    expect(body.totals.llmTokens).toBe(1_050_000);
    expect(body.byModel[0].totalTokens).toBe(1_050_000);
    expect(body.byModel[0].estimatedTokens).toBe(1_050_000);
  });

  it('does not accept a caller-supplied owner id as the usage scope', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/usage?ownerId=user%3Abob&months=2026-06'),
    );

    expect(withRequestOwnerId).toHaveBeenCalledOnce();
    expect(readUsageRecords).toHaveBeenLastCalledWith({
      months: ['2026-06'],
      ownerId: 'user:alice',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('scopes an authenticated read to the tenant the session is acting in', async () => {
    vi.mocked(withRequestOwnerId).mockImplementationOnce(async (_request, handler) =>
      handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'tenant-b' }),
    );

    await GET(new NextRequest('http://localhost/api/usage'));

    expect(readUsageRecords).toHaveBeenLastCalledWith({
      ownerId: 'user:alice',
      tenantId: 'tenant-b',
    });
  });

  it('preserves the legacy deployment-wide usage view', async () => {
    const legacyHeaders = new Headers({ 'Set-Cookie': 'openmaic_owner=anon-owner' });
    vi.mocked(withRequestOwnerId).mockImplementationOnce(async (_request, handler) =>
      handler('anon:legacy', legacyHeaders),
    );
    const response = await GET(new NextRequest('http://localhost/api/usage'));

    expect(readUsageRecords).toHaveBeenLastCalledWith({});
    expect(response.headers.get('set-cookie')).toContain('openmaic_owner=anon-owner');
  });
});
