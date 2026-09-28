import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(root, 'migrations');
const connectionString = process.env.DATABASE_URL?.trim();
const lockName = 'openmaic-schema-migrations';

if (!connectionString) {
  throw new Error('DATABASE_URL must be set to run database migrations');
}

const filenames = (await readdir(migrationsDirectory))
  .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
  .sort();
if (filenames.length === 0) throw new Error('No versioned SQL migrations were found');

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
let client;
let lockAcquired = false;

try {
  client = await pool.connect();
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
  lockAcquired = true;
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const filename of filenames) {
    const version = Number(filename.slice(0, 4));
    const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT name, checksum FROM schema_migrations WHERE version = $1',
      [version],
    );

    if (existing.rowCount) {
      const applied = existing.rows[0];
      if (applied.name !== filename || applied.checksum !== checksum) {
        throw new Error(`Applied migration ${filename} differs from its recorded name or checksum`);
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [version, filename, checksum],
      );
      await client.query('COMMIT');
      process.stdout.write(`Applied ${filename}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  try {
    if (client && lockAcquired) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
    }
  } finally {
    client?.release();
    await pool.end();
  }
}
