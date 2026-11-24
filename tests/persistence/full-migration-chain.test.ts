import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, test } from 'vitest';

const migrationsDirectory = path.join(process.cwd(), 'migrations');
let db: PGlite | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

test('applies the complete migration chain to a legacy application schema', async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(
    await readFile(path.join(process.cwd(), 'tests/e2e/enterprise-baseline.sql'), 'utf8'),
  );

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  expect(filenames.map((filename) => Number(filename.slice(0, 4)))).toEqual(
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
  for (const filename of filenames) {
    await db.exec(await readFile(path.join(migrationsDirectory, filename), 'utf8'));
  }

  const readTenant = async (table: string, keyColumn: string, key: string) => {
    const result = await db!.query<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM ${table} WHERE ${keyColumn} = $1`,
      [key],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.tenant_id;
  };

  await expect(readTenant('stage_meta', 'stage_id', 'stage-user')).resolves.toBe('default');
  await expect(readTenant('document_folders', 'id', 'folder-user')).resolves.toBe('default');
  await expect(readTenant('document_stages', 'id', 'document-user')).resolves.toBe('default');
  await expect(readTenant('agent_sessions', 'id', 'session-user')).resolves.toBe('default');
  await expect(readTenant('agent_sessions', 'id', 'session-anon')).resolves.toBeNull();
  await expect(readTenant('asset_entries', 'id', 'asset-user')).resolves.toBe('default');
  await expect(readTenant('asset_entries', 'id', 'asset-anon')).resolves.toBeNull();
  await expect(readTenant('owner_material', 'id', 'material-user')).resolves.toBe('default');
  await expect(readTenant('owner_material', 'id', 'material-anon')).resolves.toBeNull();
  await expect(readTenant('agent_owner_session_events', 'owner_id', 'user:legacy')).resolves.toBe(
    'default',
  );
  await expect(
    readTenant('agent_owner_session_events', 'owner_id', 'anon:legacy'),
  ).resolves.toBeNull();

  await db.exec(`
    INSERT INTO app_users (id, display_name) VALUES ('selector-user', 'E2E Selector');
    INSERT INTO external_identities (id, user_id, issuer, subject, email_snapshot, email_verified)
    VALUES (
      'selector-identity', 'selector-user',
      'https://localhost:8443/realms/openmaic',
      'ca584c2e-4d79-48b4-8742-f9722c520a27',
      'selector@example.test', true
    );
    INSERT INTO tenant_memberships (tenant_id, user_id, role)
    VALUES ('default', 'selector-user', 'owner');
  `);
  await db.exec(
    await readFile(
      path.join(process.cwd(), 'tests/e2e/enterprise-multitenant-membership.sql'),
      'utf8',
    ),
  );
  const memberships = await db.query<{ tenant_id: string; role: string }>(
    `SELECT m.tenant_id, m.role
       FROM tenant_memberships m
       JOIN external_identities i ON i.user_id = m.user_id
      WHERE i.subject = $1
      ORDER BY m.tenant_id`,
    ['ca584c2e-4d79-48b4-8742-f9722c520a27'],
  );
  expect(memberships.rows).toEqual([
    { tenant_id: 'default', role: 'owner' },
    { tenant_id: 'secondary', role: 'viewer' },
  ]);
  const secondaryGrant = await db.query<{ reason: string }>(
    `SELECT reason FROM tenant_role_audit WHERE id = $1`,
    ['enterprise-e2e-secondary-grant'],
  );
  expect(secondaryGrant.rows).toEqual([{ reason: 'enterprise-e2e-multi-tenant-fixture' }]);
}, 60_000);
