import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(root, 'migrations');
const runnerPath = path.join(root, 'scripts', 'migrate-database.mjs');

if (process.env.ENTERPRISE_MIGRATION_PG_REQUIRED !== '1') {
  throw new Error(
    'Set ENTERPRISE_MIGRATION_PG_REQUIRED=1 in the required PostgreSQL CI step; ' +
      'this contract must not silently become optional.',
  );
}

const contractUrl = process.env.PG_CONTRACT_URL?.trim();
if (!contractUrl) {
  throw new Error('PG_CONTRACT_URL must point to the isolated PostgreSQL contract service.');
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function connectionUrlForSchema(baseUrl, schema) {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

function runMigrationRunner(databaseUrl) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function loadMigrations() {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  assert.ok(filenames.length > 0, 'no versioned SQL migrations were found');
  const migrations = await Promise.all(
    filenames.map(async (name) => {
      const version = Number(name.slice(0, 4));
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      return { version, name, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    Array.from({ length: 23 }, (_, index) => index + 1),
    'update this contract when the migration chain changes',
  );
  return migrations;
}

async function createLegacyBaseline(pool) {
  const sql = await readFile(path.join(root, 'tests', 'e2e', 'enterprise-baseline.sql'), 'utf8');
  await pool.query(sql);
}

async function readTenant(pool, table, keyColumn, key) {
  const result = await pool.query(`SELECT tenant_id FROM ${table} WHERE ${keyColumn} = $1`, [key]);
  assert.equal(result.rowCount, 1, `${table}.${keyColumn}=${key} should exist`);
  return result.rows[0].tenant_id;
}

const schema = `enterprise_migration_contract_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = quoteIdentifier(schema);
const schemaUrl = connectionUrlForSchema(contractUrl, schema);
const adminPool = new Pool({
  connectionString: contractUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
let contractPool;
let schemaCreated = false;

try {
  await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
  schemaCreated = true;
  contractPool = new Pool({ connectionString: schemaUrl, max: 2, connectionTimeoutMillis: 5_000 });
  const migrations = await loadMigrations();
  await createLegacyBaseline(contractPool);

  const firstRun = runMigrationRunner(schemaUrl);
  assert.equal(
    firstRun.status,
    0,
    `the migration runner failed on a clean legacy schema:\n${firstRun.stdout}\n${firstRun.stderr}`,
  );
  const appliedRows = await contractPool.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  assert.equal(appliedRows.rowCount, migrations.length);
  assert.deepEqual(
    appliedRows.rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      checksum: row.checksum,
    })),
    migrations,
    'schema_migrations must record each current filename and SHA-256 checksum',
  );

  assert.equal(await readTenant(contractPool, 'stage_meta', 'stage_id', 'stage-user'), 'default');
  assert.equal(await readTenant(contractPool, 'document_folders', 'id', 'folder-user'), 'default');
  assert.equal(await readTenant(contractPool, 'document_stages', 'id', 'document-user'), 'default');
  assert.equal(await readTenant(contractPool, 'agent_sessions', 'id', 'session-user'), 'default');
  assert.equal(await readTenant(contractPool, 'agent_sessions', 'id', 'session-anon'), null);
  assert.equal(await readTenant(contractPool, 'asset_entries', 'id', 'asset-user'), 'default');
  assert.equal(await readTenant(contractPool, 'asset_entries', 'id', 'asset-anon'), null);
  assert.equal(await readTenant(contractPool, 'owner_material', 'id', 'material-user'), 'default');
  assert.equal(await readTenant(contractPool, 'owner_material', 'id', 'material-anon'), null);
  assert.equal(
    await readTenant(contractPool, 'agent_owner_session_events', 'owner_id', 'user:legacy'),
    'default',
  );
  assert.equal(
    await readTenant(contractPool, 'agent_owner_session_events', 'owner_id', 'anon:legacy'),
    null,
  );

  const secondRun = runMigrationRunner(schemaUrl);
  assert.equal(
    secondRun.status,
    0,
    `the migration runner failed on an idempotent rerun:\n${secondRun.stdout}\n${secondRun.stderr}`,
  );
  assert.doesNotMatch(
    secondRun.stdout,
    /^Applied /m,
    'a rerun must not reapply recorded migrations',
  );

  const latest = migrations.at(-1);
  await contractPool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
    latest.version,
    '0'.repeat(64),
  ]);
  const checksumRun = runMigrationRunner(schemaUrl);
  assert.notEqual(checksumRun.status, 0, 'checksum drift must make the migration runner fail');
  assert.match(
    checksumRun.stderr,
    /differs from its recorded name or checksum/,
    'checksum rejection must identify migration metadata drift',
  );

  console.log(
    `Verified ${migrations.length} migrations against PostgreSQL: clean upgrade, legacy backfills, ` +
      'idempotent rerun and checksum-drift rejection.',
  );
} finally {
  try {
    await contractPool?.end();
  } finally {
    try {
      if (schemaCreated) await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  }
}
