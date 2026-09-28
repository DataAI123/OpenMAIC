/**
 * Provisions a tenant and its first owner.
 *
 * Tenant creation is deliberately not a self-service API: an owner may rename,
 * suspend or reactivate the tenant they are in (PATCH /api/tenant/{id}), but
 * bringing a *new* tenant into existence is an operator action, performed here
 * against the database with the same audit shape the API writes.
 *
 * Usage:
 *   node scripts/provision-tenant.mjs \
 *     --tenant-id acme --slug acme --name "Acme Corporation" --owner-user-id <uuid>
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TENANT_NAME_LENGTH = 200;

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name.slice(2))) {
      throw new Error('Expected unique --name value arguments');
    }
    values.set(name.slice(2), value);
  }
  for (const name of values.keys()) {
    if (!['tenant-id', 'slug', 'name', 'owner-user-id'].includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }
  }
  const tenantId = values.get('tenant-id');
  const slug = values.get('slug');
  const name = values.get('name')?.trim();
  const ownerUserId = values.get('owner-user-id');
  if (!tenantId || !slug || !name || !ownerUserId) {
    throw new Error('--tenant-id, --slug, --name, and --owner-user-id are required');
  }
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('--tenant-id must be 1-64 characters of [A-Za-z0-9._-], starting alphanumeric');
  }
  if (!TENANT_ID_PATTERN.test(slug)) {
    throw new Error('--slug must be 1-64 characters of [A-Za-z0-9._-], starting alphanumeric');
  }
  if (name.length > MAX_TENANT_NAME_LENGTH) throw new Error('--name is too long');
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw new Error('--name must not contain control characters');
  return { tenantId, slug, name, ownerUserId };
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL must be set');
const input = parseArguments(process.argv.slice(2));
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM tenants WHERE id = $1 OR slug = $2', [
      input.tenantId,
      input.slug,
    ]);
    if (existing.rowCount !== 0) {
      throw new Error('A tenant with that id or slug already exists');
    }
    const owner = await client.query('SELECT id, status FROM app_users WHERE id = $1 FOR UPDATE', [
      input.ownerUserId,
    ]);
    if (owner.rowCount !== 1) {
      throw new Error('--owner-user-id does not identify an existing internal user');
    }
    if (owner.rows[0].status !== 'active') {
      throw new Error('--owner-user-id identifies a disabled user');
    }

    await client.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [
      input.tenantId,
      input.slug,
      input.name,
    ]);
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [input.tenantId, input.ownerUserId],
    );
    // Two trails on purpose: `tenant_admin_audit` records the tenant lifecycle
    // action (creation), `tenant_role_audit` records the role binding it
    // necessarily created. The acting user is unknown on the CLI path.
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, NULL, $3, 'create', $4, 'cli')`,
      [randomUUID(), input.tenantId, input.ownerUserId, input.slug],
    );
    await client.query(
      `INSERT INTO tenant_role_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
       VALUES ($1, $2, NULL, $3, 'grant', NULL, 'owner', 'cli', $4)`,
      [randomUUID(), input.tenantId, input.ownerUserId, 'provision-tenant'],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(
    `Provisioned tenant ${input.tenantId} (${input.slug}) with owner ${input.ownerUserId}.\n`,
  );
} finally {
  await pool.end();
}
