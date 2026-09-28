import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const allowedRoles = new Set(['owner', 'admin', 'member', 'viewer']);

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
    if (!['issuer', 'subject', 'role', 'display-name', 'email', 'user-id'].includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }
  }
  const issuer = values.get('issuer');
  const subject = values.get('subject');
  const role = values.get('role');
  if (!issuer || !subject || !role || !allowedRoles.has(role)) {
    throw new Error('--issuer, --subject, and --role (owner/admin/member/viewer) are required');
  }
  const issuerUrl = new URL(issuer);
  if (
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash ||
    issuerUrl.pathname === '/'
  ) {
    throw new Error('--issuer must identify an OIDC realm without credentials, query, or fragment');
  }
  const localHttp =
    issuerUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname);
  if (issuerUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('--issuer must use HTTPS except on localhost');
  }
  if (!subject.trim() || subject.length > 512 || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error('--subject must be a non-empty stable OIDC subject');
  }
  const displayName = values.get('display-name') ?? null;
  const email = values.get('email') ?? null;
  if (displayName && displayName.length > 200) throw new Error('--display-name is too long');
  if (email && email.length > 320) throw new Error('--email is too long');
  const userId = values.get('user-id') ?? randomUUID();
  return {
    issuer: issuerUrl.href,
    subject,
    role,
    displayName,
    email,
    userId,
    existingUserId: values.get('user-id'),
  };
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL must be set');
const input = parseArguments(process.argv.slice(2));
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.existingUserId) {
      const user = await client.query('SELECT id, status FROM app_users WHERE id = $1 FOR UPDATE', [
        input.userId,
      ]);
      if (user.rowCount !== 1) {
        throw new Error('--user-id does not identify an existing internal user');
      }
      if (user.rows[0].status !== 'active') {
        throw new Error('--user-id identifies a disabled user');
      }
    } else {
      await client.query('INSERT INTO app_users (id, display_name) VALUES ($1, $2)', [
        input.userId,
        input.displayName,
      ]);
    }
    await client.query(
      `INSERT INTO external_identities (id, user_id, issuer, subject, email_snapshot, email_verified)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [randomUUID(), input.userId, input.issuer, input.subject, input.email],
    );
    const insertedMembership = await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ('default', $1, $2)
       ON CONFLICT (tenant_id, user_id) DO NOTHING
       RETURNING role, status`,
      [input.userId, input.role],
    );
    const membership =
      insertedMembership.rows[0] ??
      (
        await client.query(
          'SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
          ['default', input.userId],
        )
      ).rows[0];
    if (!membership) throw new Error('Default tenant membership was not created');
    if (membership.status !== 'active') {
      throw new Error('Existing default membership is suspended; no identity was provisioned');
    }
    if (membership.role !== input.role) {
      throw new Error(
        `Existing default membership has role ${membership.role}; role changes are an ` +
          'administrative action — use PUT /api/tenant/members/{userId} with an owner or admin session',
      );
    }
    // A brand-new membership is a grant and must be audited. An existing
    // membership that already matches the requested role changed nothing, so it
    // writes no row. The acting user is unknown on the CLI path, hence NULL.
    if (insertedMembership.rowCount === 1) {
      await client.query(
        `INSERT INTO tenant_role_audit
           (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
         VALUES ($1, 'default', NULL, $2, 'grant', NULL, $3, 'cli', $4)`,
        [randomUUID(), input.userId, input.role, 'provision-enterprise-user'],
      );
    }
    await client.query('COMMIT');
    input.effectiveRole = membership.role;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(
    `Provisioned user ${input.userId} in tenant default with role ${input.effectiveRole}.\n`,
  );
} finally {
  await pool.end();
}
