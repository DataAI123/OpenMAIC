-- Add a deterministic second membership for the disposable OIDC selector user.
-- These are fixture grants, recorded in the same audit ledger as CLI grants.
BEGIN;
SELECT set_config(
  'app.enterprise_e2e_issuer',
  'https://localhost:8443/realms/openmaic',
  false
);
SELECT set_config(
  'app.enterprise_e2e_subject',
  'ca584c2e-4d79-48b4-8742-f9722c520a27',
  false
);

INSERT INTO tenants (id, slug, name)
VALUES ('secondary', 'secondary', 'Secondary organization');

INSERT INTO tenant_memberships (tenant_id, user_id, role)
SELECT 'secondary', external_identity.user_id, 'viewer'
  FROM external_identities AS external_identity
 WHERE external_identity.issuer = current_setting('app.enterprise_e2e_issuer')
   AND external_identity.subject = current_setting('app.enterprise_e2e_subject');

INSERT INTO tenant_role_audit
  (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
SELECT 'enterprise-e2e-secondary-grant', 'secondary', NULL, external_identity.user_id,
       'grant', NULL, 'viewer', 'cli', 'enterprise-e2e-multi-tenant-fixture'
  FROM external_identities AS external_identity
 WHERE external_identity.issuer = current_setting('app.enterprise_e2e_issuer')
   AND external_identity.subject = current_setting('app.enterprise_e2e_subject');

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tenant_memberships m
       JOIN external_identities i ON i.user_id = m.user_id
      WHERE i.issuer = current_setting('app.enterprise_e2e_issuer')
        AND i.subject = current_setting('app.enterprise_e2e_subject')
        AND m.tenant_id IN ('default', 'secondary')
        AND m.status = 'active') <> 2 THEN
    RAISE EXCEPTION 'Expected exactly two active memberships for selector fixture';
  END IF;
END $$;

COMMIT;
