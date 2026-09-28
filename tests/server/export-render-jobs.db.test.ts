/**
 * Database-backed contract tests for the export render job ownership engine.
 *
 * Runs the real INSERT / SELECT / DELETE against a PGlite Postgres with
 * migration 0009 applied, so first-writer-wins binding, the uniform "not owned"
 * answer for foreign/unknown ids, and the retention sweep are verified for real
 * rather than mocked away.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('@/lib/persistence/server-provider', () => {
  const normalize = async (sql: string, params?: unknown[]) => {
    const res = await state.db.query(sql, (params ?? []) as never[]);
    const isSelect = /^\s*(select|with)\b/i.test(sql);
    return {
      rows: res.rows,
      rowCount: isSelect ? res.rows.length : (res.affectedRows ?? res.rows.length),
    };
  };
  const pool = {
    query: (sql: string, params?: unknown[]) => normalize(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => normalize(sql, params),
      release: () => {},
    }),
    end: async () => {},
  };
  return { getServerPersistenceProvider: async () => ({ pool }) };
});

const OWNER = 'user:owner-a';
const OTHER = 'user:owner-b';

let recordRenderJobOwner: typeof import('@/lib/server/export-render-jobs').recordRenderJobOwner;
let assertRenderJobOwnedBy: typeof import('@/lib/server/export-render-jobs').assertRenderJobOwnedBy;
let isSafeRenderJobId: typeof import('@/lib/server/export-render-jobs').isSafeRenderJobId;
let DbUnavailable: typeof import('@/lib/server/export-render-jobs').ExportRenderJobDatabaseUnavailableError;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://bridge/not-used';
  state.db = new PGlite();
  await state.db.exec(
    await readFile(
      path.join(process.cwd(), 'migrations', '0009_export_render_job_ownership.sql'),
      'utf8',
    ),
  );
  const engine = await import('@/lib/server/export-render-jobs');
  recordRenderJobOwner = engine.recordRenderJobOwner;
  assertRenderJobOwnedBy = engine.assertRenderJobOwnedBy;
  isSafeRenderJobId = engine.isSafeRenderJobId;
  DbUnavailable = engine.ExportRenderJobDatabaseUnavailableError;
});

afterAll(async () => {
  await state.db?.close();
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  await state.db.exec('TRUNCATE export_render_job_owners');
});

describe('isSafeRenderJobId', () => {
  it('accepts ordinary job ids and rejects pathological ones', () => {
    expect(isSafeRenderJobId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isSafeRenderJobId('abc-123_XYZ')).toBe(true);
    expect(isSafeRenderJobId('')).toBe(false);
    expect(isSafeRenderJobId('a/b')).toBe(false);
    expect(isSafeRenderJobId('a\\b')).toBe(false);
    expect(isSafeRenderJobId('has space')).toBe(false);
    expect(isSafeRenderJobId('x'.repeat(257))).toBe(false);
    // Non-string still reads as unsafe (the guard accepts `unknown`).
    expect(isSafeRenderJobId(42)).toBe(false);
  });
});

describe('export render job ownership engine (real SQL)', () => {
  it('binds a job to its owner and refuses every other caller', async () => {
    await recordRenderJobOwner('job-1', OWNER);
    expect(await assertRenderJobOwnedBy('job-1', OWNER)).toBe(true);
    // A foreign owner and an unknown job both read as "not owned" — the same
    // answer the routes turn into one uniform 404.
    expect(await assertRenderJobOwnedBy('job-1', OTHER)).toBe(false);
    expect(await assertRenderJobOwnedBy('job-missing', OWNER)).toBe(false);
  });

  it('first writer wins: a retried submit cannot re-point an existing binding', async () => {
    await recordRenderJobOwner('job-dup', OWNER);
    await recordRenderJobOwner('job-dup', OTHER);
    expect(await assertRenderJobOwnedBy('job-dup', OWNER)).toBe(true);
    expect(await assertRenderJobOwnedBy('job-dup', OTHER)).toBe(false);
  });

  it('sweeps bindings older than the retention window on the next submit', async () => {
    await recordRenderJobOwner('job-old', OWNER);
    await recordRenderJobOwner('job-fresh', OWNER);
    await state.db.exec(
      `UPDATE export_render_job_owners
          SET created_at = CURRENT_TIMESTAMP - INTERVAL '8 days'
        WHERE job_id = 'job-old'`,
    );
    // Any submit triggers the best-effort sweep, reclaiming the aged binding.
    await recordRenderJobOwner('job-newer', OWNER);
    const { rows } = await state.db.query<{ job_id: string }>(
      `SELECT job_id FROM export_render_job_owners WHERE job_id = 'job-old'`,
    );
    expect(rows).toHaveLength(0);
    // The fresh binding is untouched.
    expect(await assertRenderJobOwnedBy('job-fresh', OWNER)).toBe(true);
  });

  it('fails closed when the store is unavailable', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(assertRenderJobOwnedBy('job-x', OWNER)).rejects.toBeInstanceOf(DbUnavailable);
      await expect(recordRenderJobOwner('job-x', OWNER)).rejects.toBeInstanceOf(DbUnavailable);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
