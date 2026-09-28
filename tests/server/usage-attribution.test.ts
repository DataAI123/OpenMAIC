import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { recordUsage, readUsageRecords, type UsageRecordInput } from '@/lib/server/usage-storage';
import {
  attributionForOwner,
  currentUsageAttribution,
  runWithUsageAttribution,
} from '@/lib/server/usage-attribution';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-attrib-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const llmInput: UsageRecordInput = {
  kind: 'llm',
  source: 'agent-runtime',
  providerId: 'deepseek',
  modelId: 'deepseek-v4-pro',
  modelString: 'deepseek:deepseek-v4-pro',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  },
};

describe('recordUsage — server-derived attribution', () => {
  it('attaches ownerId + tenantId from the ambient OIDC scope', async () => {
    await runWithUsageAttribution({ ownerId: 'user:abc', tenantId: 'default' }, async () => {
      await recordUsage(llmInput, { baseDir: tmpDir });
    });
    const [r] = await readUsageRecords({ baseDir: tmpDir });
    expect(r.ownerId).toBe('user:abc');
    expect(r.tenantId).toBe('default');
  });

  it('records only ownerId for a legacy anonymous owner (no tenant)', async () => {
    await runWithUsageAttribution({ ownerId: 'anon:xyz' }, async () => {
      await recordUsage(llmInput, { baseDir: tmpDir });
    });
    const [r] = await readUsageRecords({ baseDir: tmpDir });
    expect(r.ownerId).toBe('anon:xyz');
    expect(r).not.toHaveProperty('tenantId');
  });

  it('leaves rows unattributed outside any principal scope', async () => {
    await recordUsage(llmInput, { baseDir: tmpDir });
    const [r] = await readUsageRecords({ baseDir: tmpDir });
    expect(r).not.toHaveProperty('ownerId');
    expect(r).not.toHaveProperty('tenantId');
  });

  it('captures the scope synchronously even for a fire-and-forget write', async () => {
    // recordUsageSafe in llm.ts spawns `void (async () => recordUsage())` without
    // awaiting; the value must still reflect the enclosing owner once the
    // request/run scope has already returned.
    const pending: Promise<unknown>[] = [];
    runWithUsageAttribution({ ownerId: 'user:late', tenantId: 'default' }, () => {
      pending.push(recordUsage(llmInput, { baseDir: tmpDir }));
      return undefined;
    });
    await Promise.all(pending);
    const [r] = await readUsageRecords({ baseDir: tmpDir });
    expect(r.ownerId).toBe('user:late');
  });

  it('reads attribution across awaits within the same scope', async () => {
    await runWithUsageAttribution({ ownerId: 'user:across' }, async () => {
      await Promise.resolve();
      expect(currentUsageAttribution()?.ownerId).toBe('user:across');
    });
    expect(currentUsageAttribution()).toBeUndefined();
  });
});

describe('attributionForOwner', () => {
  it('maps OIDC user owners to the controlled default tenant', () => {
    expect(attributionForOwner('user:abc')).toEqual({ ownerId: 'user:abc', tenantId: 'default' });
  });

  it('prefers an explicit tenant so a user in two tenants is attributed correctly', () => {
    expect(attributionForOwner('user:abc', 'tenant-b')).toEqual({
      ownerId: 'user:abc',
      tenantId: 'tenant-b',
    });
  });

  it('leaves legacy anonymous and public owners without a tenant', () => {
    expect(attributionForOwner('anon:xyz')).toEqual({ ownerId: 'anon:xyz' });
    expect(attributionForOwner('public:anonymous')).toEqual({ ownerId: 'public:anonymous' });
  });
});
