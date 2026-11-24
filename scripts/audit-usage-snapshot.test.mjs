import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditUsageSnapshot } from './audit-usage-snapshot.mjs';

const row = {
  id: 'same-legacy-id',
  createdAt: Date.UTC(2026, 9, 1),
  source: 'scene',
  providerId: 'fixture',
  modelId: 'fixture',
  modelString: 'fixture:fixture',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  ownerId: 'user:fixture',
  tenantId: 'fixture-tenant',
};

async function withSnapshot(content, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-snapshot-test-'));
  const file = path.join(dir, 'snapshot.jsonl');
  try {
    await writeFile(file, content);
    await run(file);
    assert.deepEqual(await readFile(file), Buffer.from(content));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(file, options = {}) {
  const rows = [];
  const summary = await auditUsageSnapshot(file, 'fixture-snapshot/2026-10.jsonl', {
    ...options,
    onRow: async (entry) => {
      rows.push(entry);
    },
  });
  return { rows, summary };
}

test('accounts for every physical row without inferring missing attribution', async () => {
  const content =
    [
      JSON.stringify(row),
      '',
      '{bad',
      JSON.stringify({ ...row, ownerId: undefined }),
      JSON.stringify({ ...row, tenantId: undefined }),
      JSON.stringify({ ...row, kind: 'video', unit: 'image', quantity: 2 }),
      JSON.stringify({ ...row, inputTokens: -1 }),
      'null',
    ].join('\n') + '\n';
  await withSnapshot(content, async (file) => {
    const { rows, summary } = await collect(file);
    assert.equal(summary.totalLines, 8);
    assert.equal(summary.reviewRequired, 1);
    assert.equal(summary.quarantined, 6);
    assert.equal(summary.excluded, 1);
    assert.equal(
      summary.totalLines,
      summary.reviewRequired + summary.quarantined + summary.excluded,
    );
    assert.deepEqual(
      rows.map((r) => r.reason),
      [
        undefined,
        'blank',
        'invalid-json',
        'missing-attribution',
        'missing-attribution',
        'invalid-usage',
        'invalid-usage',
        'invalid-record',
      ],
    );
    assert.equal(rows[0].kind, 'llm');
    assert.equal(rows[0].period, '2026-10');
    assert.equal(rows[0].inputTokens, 10);
  });
});

test('uses source identity, byte offset and content hash, never the legacy id, for stable keys', async () => {
  const line = JSON.stringify({ ...row, source: '中文' });
  const content = `${line}\r\n${line}`;
  await withSnapshot(content, async (file) => {
    const first = await collect(file);
    const second = await collect(file);
    assert.deepEqual(first, second);
    assert.notEqual(first.rows[0].sourceKey, first.rows[1].sourceKey);
    assert.equal(first.rows[1].byteOffset, Buffer.byteLength(line + '\r\n'));
    assert.equal(first.summary.snapshotSha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(
      first.rows[0].contentSha256,
      createHash('sha256')
        .update(line + '\r')
        .digest('hex'),
    );
    const other = [];
    await auditUsageSnapshot(file, 'other-source', { onRow: (r) => other.push(r) });
    assert.notEqual(other[0].sourceKey, first.rows[0].sourceKey);
  });
});

test('keeps reported tokens and estimates separate and validates all modalities', async () => {
  const content = [
    { ...row, quotaEstimatedTokens: 100 },
    ...[
      ['image', 'image', 2],
      ['video', 'second', 2.5],
      ['tts', 'character', 4],
      ['asr', 'second', 1.5],
    ].map(([kind, unit, quantity]) => ({
      ...row,
      inputTokens: 0,
      outputTokens: 0,
      kind,
      unit,
      quantity,
    })),
    { ...row, quotaEstimatedTokens: 1.5 },
    { ...row, kind: 'tts', unit: 'character', quantity: 1.5 },
    { ...row, createdAt: 1e30 },
    { ...row, createdAt: 8.64e15 },
    { ...row, kind: { toString: 1 } },
  ]
    .map(JSON.stringify)
    .join('\n');
  await withSnapshot(content, async (file) => {
    const { rows, summary } = await collect(file);
    assert.equal(summary.reviewRequired, 5);
    assert.equal(summary.quarantined, 5);
    assert.equal(rows[0].quotaEstimatedTokens, 100);
    assert.equal(rows[0].inputTokens, 10);
    assert.equal(rows[2].quantity, 2.5);
  });
});

test('bounds oversized lines, rejects invalid UTF-8 and continues after quarantine', async () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1, 120);
  const content = Buffer.concat([
    oversized,
    Buffer.from('\n'),
    Buffer.from([0xff, 0x0a]),
    Buffer.from(JSON.stringify(row)),
  ]);
  await withSnapshot(content, async (file) => {
    const { rows, summary } = await collect(file);
    assert.deepEqual(
      rows.map((r) => r.reason),
      ['line-too-large', 'invalid-utf8', undefined],
    );
    assert.equal(rows[2].byteOffset, oversized.length + 3);
    assert.equal(summary.reviewRequired, 1);
  });
});

test('outputs only allowlisted fields, including for malformed rows', async () => {
  const content = [
    JSON.stringify({ ...row, apiKey: 'SECRET', modelString: 'SECRET', source: 'SECRET' }),
    'SECRET malformed',
  ].join('\n');
  await withSnapshot(content, async (file) => {
    const result = await collect(file);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(JSON.stringify(result).includes(row.ownerId), false);
    assert.equal(JSON.stringify(result).includes(row.tenantId), false);
    assert.ok(result.rows[0].scopeSha256);
  });
});

test('empty input has zero rows and I/O or output failures reject instead of claiming success', async () => {
  await withSnapshot('', async (file) => {
    const { summary } = await collect(file);
    assert.equal(summary.totalLines, 0);
  });
  await assert.rejects(collect(path.join(os.tmpdir(), 'missing-usage-snapshot', 'no-file')));
  await withSnapshot(JSON.stringify(row), async (file) => {
    await assert.rejects(
      auditUsageSnapshot(file, 'fixture', {
        onRow: () => {
          throw new Error('sink failed');
        },
      }),
      /sink failed/,
    );
    await assert.rejects(auditUsageSnapshot(file, ''), /source-id/);
  });
});

test('CLI requires explicit inputs and emits a final summary only after a successful read', async () => {
  const script = path.resolve('scripts/audit-usage-snapshot.mjs');
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  await withSnapshot(JSON.stringify(row), async (file) => {
    const result = spawnSync(process.execPath, [script, '--file', file, '--source-id', 'fixture'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      lines.map((r) => r.type),
      ['row', 'summary'],
    );
    assert.equal(lines[1].reviewRequired, 1);
    assert.equal(lines[1].imported, undefined);
  });
});

test('rejects a snapshot changed during reading and does not return a complete report', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-snapshot-mutation-test-'));
  const file = path.join(dir, 'snapshot.jsonl');
  try {
    await writeFile(file, JSON.stringify(row) + '\n');
    let changed = false;
    await assert.rejects(
      auditUsageSnapshot(file, 'fixture', {
        onRow: async () => {
          if (!changed) {
            changed = true;
            await appendFile(file, '\n');
          }
        },
      }),
      /Snapshot changed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
