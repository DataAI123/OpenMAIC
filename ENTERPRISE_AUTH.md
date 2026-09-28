# Enterprise authentication rollout

This repository is implementing the enterprise plan in gated increments. The
default remains `legacy` for existing deployments. In OIDC mode, middleware
admits only owner-scoped API families, a narrow set of potential public GET
routes, `/api/auth/*`, and `/api/health`. The Node owner boundary rechecks the
database-backed session and tenant membership for each admitted request. Other
business APIs remain `503`, and OIDC may be rolled out with that closed set: the
routes that stay closed are declared in `ENTERPRISE_ROUTE_INVENTORY.md` (today
only `/access-code/verify`, whose verified `openmaic_access` cookie can never
admit a business route in OIDC mode, so the channel is permanently disabled and
must remain `503`). The Pi director turn (`/api/chat/pi`) and its whiteboard
visibility callback are admitted as owner-scoped POSTs: the turn charges a
per-user `chat_pi` fixed window before any provider call, and the callback runs
behind the same owner boundary plus the persistence principal so a logged-in
caller cannot settle another principal's pending query. The access-code
status probe is admitted as a degraded, non-authenticating read: in OIDC mode
`/api/access-code/status` reports `enabled: false` so the app-wide
`AccessCodeGuard` stops showing a modal no code can satisfy, and it never reads
or mints a credential. The release gate and rollback path are in "Deployment and
rollback" below.

The currently admitted owner-scoped API families are stages, stage metadata,
folders, materials, skills, agent sessions/events, and the document/runtime
subpaths of `/api/persistence`. Unauthenticated public reads are limited to
specific stage document, scenes, manifest/status, stage metadata, document
persistence, and asset-content GET patterns. Each handler checks owner,
published visibility, and tombstones; private or tombstoned resources answer
`404`. OIDC asset allocations use a per-user principal. Asset content is
readable by its owner or through a live public course reference whose owner
matches that principal. Legacy shared assets are readable publicly only when a
published legacy anonymous course references them. Asset replacement and
deletion remain disabled. Cost-generating APIs, provider configuration routes,
and all other unreviewed APIs remain closed in OIDC mode.

## Client access channel

Enterprise (OIDC) access is **browser-only by accepted product decision**. The
edge gate and the Node owner boundary authenticate exclusively through the
signed application-session cookie, so every admitted API is cookie-session
scoped. No inbound `Authorization: Bearer` identity path exists in either mode:
the legacy channel validates the `openmaic_access` HMAC cookie, and OIDC
verifies the app-session cookie. In particular, the `Authorization: Bearer
<access-code>` convention documented by the external `openmaic` agent skill is
honored by neither mode. The access-code verify route stays `503` in OIDC mode,
and the status probe is admitted only as a read that reports the channel
disabled — neither can admit a request.
Third-party/headless clients that need the skill flow therefore cannot use an
OIDC deployment today; recognizing a bearer channel would be a separate,
explicit product and security decision.

## Client sign-in handling

The browser's only job is to display state and navigate; it is never an
authorization boundary. All client handling of `login_required` goes through
one rule in `lib/auth/client-login.ts`: when a component discovers a
`401 LOGIN_REQUIRED` (or the thrown `LOGIN_REQUIRED` from a workspace Server
Action or the learner-key seam), it sends the visitor to `/api/auth/login` with
a same-site relative `returnTo`. The client builds only a relative path and
treats it as a convenience — the server re-validates `returnTo` and remains the
boundary. `AUTH_UNAVAILABLE` is deliberately **not** a redirect: the auth
backend being down must not start a login loop.

After the IdP round-trip, a single mounted notice shows the outcome
(`denied`, `failed`, or `unavailable`) and removes the `auth` parameter from the
URL, so no authentication result is left in the business URL. Page-level
requests still need no client gate: middleware redirects an unauthenticated page
to login before it renders.

## OIDC provider

Register a confidential Keycloak client with Authorization Code flow, S256
PKCE, and the exact callback URI configured by `OIDC_REDIRECT_URI`. Configure
the realm issuer exactly as published by its discovery document. The app
requests `openid profile email`; it does not persist provider access or refresh
tokens in the browser.

Identity is mapped by `(issuer, subject)` to an internal application user ID.
Application membership and roles come from the database, not email addresses
or unverified client input. Application sessions are short-lived and
database-backed so logout, disabled users, and suspended membership can be
enforced. The browser's runtime learner key is derived from the authenticated
internal user ID in OIDC mode; anonymous data is not automatically merged.

Set `APP_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and
`OIDC_REDIRECT_URI`. Production URLs must use HTTPS. Generate independent
random 32-byte keys and encode each with base64url for
`OPENMAIC_SESSION_SIGNING_KEY` and `OPENMAIC_OIDC_FLOW_KEY`. The session lifetime
defaults to 900 seconds and is limited to 300–3600 seconds.
Issuer and callback URLs must use HTTP(S); plain HTTP is limited to loopback.
The callback URI must use `/api/auth/callback`, match `APP_ORIGIN`, and contain
no configured query string.
Session signing currently accepts one key (`kid: v1`); rotating it invalidates
all existing app sessions and requires users to sign in again. Rotating the
flow key invalidates outstanding login flows, which must be restarted.

**Realm and environment isolation.** Each environment registers its own client
in its own realm: production has a confidential client whose secret and signing
keys live only in the production secret store, while development and CI use a
separate, disposable realm with different client secret, `APP_ORIGIN`,
`OIDC_ISSUER`, callback URI, and keys. A development or test realm must never
reuse the production realm, client secret, or signing keys, and a shipped image
must not carry them. Users provisioned in a dev realm are unrelated to
production identities because the mapping key is the exact `(issuer, subject)`
pair.

OIDC write requests at owner-scoped API boundaries require an exact same-origin
`Origin`; `SameSite=Lax` is an additional browser control. Workspace Server
Actions apply the same origin check. `viewer` membership is read-only at these
boundaries. Local logout revokes the application session and clears its cookie;
it does not end the Keycloak SSO session.

## Schema and user provisioning

Run `pnpm db:migrate` from the exact release checkout in a controlled release
runner after reviewing the SQL and independently confirming the target database.
The production Docker runtime image contains the Next standalone server but not
the migration script or SQL files, so run this step outside that image. Inject
`DATABASE_URL` from the deployment secret store and never print it in logs. The
migration adds identity/session/membership tables
and assigns existing `stage_meta` records to the `default` tenant; it does not
claim anonymous records for any person. Application startup does not run these
migrations. Phase 1 admits users only to the controlled `default` tenant; the
session resolver does not implicitly choose among multiple memberships.

Auto-provisioning is disabled by default. Provision an approved identity and
membership explicitly:

```powershell
pnpm enterprise:provision-user -- --issuer $env:OIDC_ISSUER --subject '<stable OIDC sub>' --display-name 'Admin' --role owner
```

Use `--role admin`, `member`, or `viewer` as appropriate. Use `--user-id` only
when linking another verified external identity to an existing internal user.
The issuer must identify the configured realm without credentials, query, or
fragment. Existing membership roles are not changed: a role mismatch, disabled
user, or suspended default membership aborts the transaction. Enabling
`OIDC_AUTO_PROVISION_USERS=true` creates a `member` in the default tenant for
any identity admitted by the configured realm, so do so only when that realm is
restricted to approved organization members.

The first provisioned owner establishes application administration. Do not
grant `owner` to an account based only on email address; the identity key is the
exact `(issuer, subject)` pair.

## Roles, permissions, and administrative audit (batches 14–16)

Authorization is a role→permission matrix in
`lib/server/auth/permissions.ts`, not a set of scattered `role === '…'`
comparisons. Four actions exist: `tenant.member.read`, `tenant.member.manage`,
`tenant.audit.read`, and `webapp.write`. `owner` and `admin` hold all four;
`member` holds only `webapp.write`; `viewer` holds none. The matrix lives in
code deliberately: permission *actions* are a code contract, and a database
matrix would need cache invalidation and would silently downgrade a role to "no
permissions" when its rows were missing. Role *binding* is the database-backed
half (`tenant_memberships.role`).

Role decisions are named, never inlined:

- Business writes resolve `webapp.write` in the owner gate
  (`lib/server/agent-runtime/with-owner.ts`) and in the workspace Server Action.
  The HTTP-method gate stays in front of it, so reads do not require a write
  permission.
- Tenant administration resolves the member/audit permissions in
  `withTenantPermission` (`lib/server/auth/authorize.ts`).

### Management API

| Route | Method | Permission |
|---|---|---|
| `/api/tenant/members` | `GET` | `tenant.member.read` |
| `/api/tenant/members/{userId}` | `PUT` | `tenant.member.manage` |
| `/api/tenant/members/{userId}` | `DELETE` | `tenant.member.manage` |
| `/api/tenant/audit` | `GET` | `tenant.audit.read` |

Each handler derives the tenant and the acting user from the verified
application session; a caller cannot pass a tenant, an actor, or an actor role.
The resolution order is fixed: configuration, identity, permission, origin. A
legacy deployment (no OIDC identity to authorize against) and an unreachable
session store both answer `503 AUTH_UNAVAILABLE`; an unauthenticated caller gets
`401 LOGIN_REQUIRED` (with the malformed cookie cleared) before any permission
is consulted, so the response never reveals whether a tenant or user exists.
Mutating verbs additionally require the request `Origin` to equal `APP_ORIGIN`.
Every response carries `Cache-Control: private, no-store`.

`assignTenantRole` and `revokeTenantMembership`
(`lib/server/auth/tenant-admin.ts`) run in one transaction. They take a
per-tenant `pg_advisory_xact_lock` — row locks alone are not enough, because two
concurrent demotions of two different owners would each still see the other
owner and both commit. Inside the lock they re-read the membership `FOR UPDATE`
and enforce two guards: an actor may only bind or modify a role strictly below
their own rank (`owner` may appoint another owner; an admin can never touch an
admin or owner), and a change or revoke that would leave the tenant with no
active owner is refused with `409`. A subject that is unknown or disabled, and a
removal of a subject with no membership in this tenant, answer the same `404`,
so the endpoint is not an enumeration oracle. (A subject active in another
tenant is a legitimate grant, not a 404: a user may belong to more than one
tenant.) A re-assignment that changes nothing is an idempotent no-op and writes
no audit row.

### Administrative audit

Migration `0017_tenant_role_audit.sql` adds `tenant_role_audit`. Every effective
role change made through the management API or the CLI provisioner writes
exactly one row: `grant` (no previous role), `change` (both roles), or `revoke`
(no new role), enforced by a shape check so an inconsistent combination cannot
be stored. Rows record the acting user (the application session's user for the
API path; `NULL` for the CLI path, where no person is authenticated), the
subject, the source (`api` or `cli`), an optional reason, and a timestamp.
Foreign keys use `ON DELETE RESTRICT` and the tenant is `ON DELETE RESTRICT`, so
the trail cannot be silently orphaned. The CLI provisioner
(`scripts/provision-enterprise-user.mjs`) writes a `grant`/`cli` row in the same
transaction as the membership insert, and refuses a role change with a message
pointing at the management API.

Auto-provisioning (`OIDC_AUTO_PROVISION_USERS=true`) is the one exception: it
creates the initial `member` membership on the login path and is deliberately
not audited, because that path is login-critical and its grant is not an
administrative decision by a tenant actor.

### When a permission change takes effect

Role binding is read on every request: the session resolver joins
`tenant_memberships` and re-derives the role, so a grant, change, or revoke
takes effect on the caller's next request with no cache to invalidate and no
re-login. Two boundaries are known to lag and are documented rather than
worked around: a long-lived SSE connection holds the session it resolved when
the connection opened for that connection's lifetime, and
`lib/server/usage-attribution.ts` still hardcodes the `default` tenant
(attribution follows the same tenant used by the session resolver until the
multi-tenant phase).

## Persistence boundary

`PERSISTENCE_DEV_TOKEN` and `NEXT_PUBLIC_PERSISTENCE_TOKEN` remain for legacy
development deployments. OIDC document and runtime requests derive their
principal from the application session and do not trust `x-learner-key`.
Legacy persistence assets remain on the shared principal. OIDC allocations
derive their principal from the internal user ID. Reads require that principal
or an active public-course reference with a matching principal; clients cannot
choose an asset principal. Asset replacement and deletion remain disabled.

### Document and course tenant boundary (batch 20)

A course document belongs to exactly one tenant, recorded on its `stage_meta`
row. The tenant is resolved server-side from the application session's
`active_tenant_id` — never from a request header, cookie, or body — and is
passed down to the owner-bound document store for every read, write, delete,
and listing (`lib/persistence/owner-bound-document-store.ts`).

- **Writes are always tenant-locked.** A mutation whose target row is in another
  tenant is refused as `StageAccessError('foreign')`, which the HTTP layer
  answers as `404 DOCUMENT_NOT_FOUND` — the same answer as a missing document,
  so the boundary is not an existence oracle. The refused write leaves the row
  untouched.
- **Reads are tenant-scoped, with one documented exception.** A row in another
  tenant reads as `null` (again the `404` face) *unless* it is a published,
  live course (`is_public AND deleted_at IS NULL`), which stays cross-tenant
  readable. This is the same public-course visibility the asset boundary
  already grants; it allows a shared or linked course to be opened without
  granting any tenant-write capability.
- **Listings filter by tenant.** The course index and document listings select
  only `stage_meta` rows whose `tenant_id` matches the session tenant, so a
  same-owner document created in another tenant is never listed.
- **Legacy mode is unchanged.** With no tenant (anonymous-cookie deployments),
  the store keeps its previous behavior and writes fall to the schema's
  `default` sentinel; no tenant comparison runs.

`document_folders` and `document_stages` also carry a `tenant_id` (migration
`0019_resource_tenant_boundaries.sql`) as a declarative resource boundary and
for indexing; the enforced gate remains `stage_meta`.

### Agent session tenant boundary (batch 21)

An agent session belongs to exactly one tenant, recorded on its
`agent_sessions` row. As everywhere else on the owner boundary, the tenant is
resolved server-side from the application session's `active_tenant_id` — never
from a request header, cookie, or body — and is handed to the session store as
an optional `tenantScope` (`@openmaic/storage/agent-session/pg`). The
application caches one store per (connection string, tenant) in
`lib/server/agent-runtime/store.ts`, so a request-scoped tenant never leaks
across requests.

- **Scoping is a store capability, not a route convention.** When
  `tenantScope` is set, every session-table statement appends
  `AND tenant_id = $n` (`loadSession`, owner listings, title writes, leases,
  cancel/requeue, event and message reads, URL checks). A row in another tenant
  reads as `null` and a cross-tenant mutation answers `false` — the same shape
  as a missing session, so the boundary is not an existence oracle. The
  refused write leaves the row untouched.
- **Child tables inherit through `session_id`.** `agent_session_events`,
  `agent_session_entries`, and `agent_session_urls` carry no tenant column of
  their own; their statements are joined or predicated on the owning session's
  `tenant_id`, so they cannot be read across tenants.
- **Legacy rows stay legacy.** `agent_sessions.tenant_id` is nullable with no
  default (migration `0020_agent_session_tenant.sql`). `NULL` marks a
  legacy/anonymous session written by an unscoped store; a tenant-scoped store
  cannot see such a row (fail-closed), while an unscoped store keeps its
  previous owner-only addressing. The migration backfills existing
  `owner_id LIKE 'user:%'` rows to the `default` sentinel and leaves `anon:%`
  rows `NULL`.
- **One statement is deliberately cross-tenant.** `claimNextSession` is the
  worker's queue-claiming entry point and carries no tenant predicate: a worker
  must be able to pick up any tenant's queued run. It returns the row's tenant
  in the claimed metadata, and `runSession` then opens a tenant-scoped store
  from that value, so the run's own reads and writes are tenant-locked even
  though the claim was not. This is the only cross-tenant statement in the
  store.
- **Known residual (batch 22).** The owner-events projection
  (`agent_owner_session_events`) is still keyed by `owner_id` and has no tenant
  column, so a single user in two tenants shares one projection stream. It is a
  read-side projection only; the authoritative `agent_sessions` boundary above
  is enforced. The tenant column and per-tenant key arrive with the batch 22
  resource boundary.

## Anonymous data policy

Legacy deployments partition owner-scoped data by the `anonymous_id` cookie
(`anon:<id>`), and the runtime layer partitions by a device-scoped
`learnerKey`. These are two unrelated client-held partitions, and neither
identifies a person.

**Decision: anonymous data is not claimed or migrated.** There is no automatic
merge, no user-initiated claim endpoint, and no operator migration script. The
cookie is HttpOnly and server-issued but it expires and is never re-proved for a
person; the learner key is client-controlled and therefore proves nothing. A
claim path would have to move rows based on evidence that cannot bind a browser
to a human, and a wrong move is unrecoverable.

**Reachability.** Once `OPENMAIC_AUTH_MODE=oidc`, no request resolves to an
`anon:` owner: the anonymous-cookie primitive runs only in the legacy branch of
the owner boundary, and an unauthenticated OIDC request is refused with `401`
(or `public:anonymous` for the explicitly public GET reads). Existing
`anon:`-keyed rows become unreachable, not reassigned, and are not deleted by
the application.

**Retention.** Unclaimed anonymous rows are retained as-is; no scheduled
deletion runs. Retaining unreachable rows is the reversible default — deleting
them is irreversible and buys nothing while they cannot be reached. Operators
may remove them explicitly (below) after a backup.

**Session lifecycle.** Local logout revokes the application session and clears
its cookie; it neither claims nor deletes anonymous data. A later sign-in by a
different person on the same browser still resolves to that person's own
`user:<id>` partition, so one visitor's anonymous data is never handed to the
next. The browser's learner key stays device-scoped; the server never rewrites
it.

### Operator inventory and cleanup

Run this read-only inventory first, against the exact release checkout in a
controlled runner, with `:owner` bound to a legacy owner value (for example an
`anon:<id>` found in `stage_meta.owner_id`):

```sql
SELECT 'document_folders' AS rel, count(*) FROM document_folders WHERE owner_id = :owner
UNION ALL SELECT 'document_stages', count(*) FROM document_stages WHERE owner_id = :owner
UNION ALL SELECT 'stage_meta', count(*) FROM stage_meta WHERE owner_id = :owner
UNION ALL SELECT 'agent_sessions', count(*) FROM agent_sessions WHERE owner_id = :owner
UNION ALL SELECT 'agent_owner_session_events', count(*) FROM agent_owner_session_events WHERE owner_id = :owner
UNION ALL SELECT 'agent_user_skill', count(*) FROM agent_user_skill WHERE owner_id = :owner
UNION ALL SELECT 'owner_material', count(*) FROM owner_material WHERE owner_id = :owner;
```

Deletion is explicit and per-table. Delete the parents (`document_stages`,
`agent_sessions`) rather than their children: scenes, outlines, session
events/entries/urls, session materials, and runtime records cascade from there.
Never delete legacy `asset_entries` by principal — legacy assets share the
`shared` principal, so a principal-keyed delete would reach other deployments'
bytes; assets are reclaimed by the asset collector once their document
references are gone.

Metering rows (`user_api_rate_limits`, `personal_*_quota_*`) never hold
anonymous data: their `user_id` is a foreign key to `app_users`, so an
anonymous row cannot exist. Render-job bindings (`export_render_job_owners`) are
short-lived and swept by the engine. Rows keyed by `runtime_sessions.learner_key`
belong to the separate device-key partition and are outside this inventory; they
are retained on the same terms.

## Deployment and rollback

Migrations are forward-only, versioned `00NN_*.sql`, checksum-locked, and each
runs in its own transaction under an advisory lock. The production Docker
runtime image contains the Next standalone server only — neither
`scripts/migrate-database.mjs` nor `migrations/` — so migrations always run
outside that image, from the exact release checkout, and never at application
startup.

### Release order

- **R0 Preflight.** Record the application commit, the database server version,
  and the target environment. Confirm the migration series (currently `0001`
  through `0019`) matches the release and that the runner reaches the intended
  database. An isolated rehearsal must not reuse the deployment's own
  `DATABASE_URL`.
- **R1 Backup.** Take a timestamped `pg_dump`, record its size and exit code,
  and restore it into an isolated database as a spot check. A backup that has
  not been restored does not count as verified. Confirm PITR availability.
- **R2 Migration.** In a maintenance window, run `pnpm db:migrate` from the
  exact release checkout in a controlled runner with `DATABASE_URL` injected
  from the deployment secret store and independently confirmed. Keep the
  migration version and outcome in the logs; never log the connection string or
  credentials. On failure the per-migration transaction rolls back: stop the
  release, inspect on an isolated copy, and do not hand-mark a migration as
  applied.
- **R3 Database acceptance.** Verify one correct name and checksum per version
  `0001` through `0019` in `schema_migrations`; check that the rate-limit
  route-key CHECK includes every admitted key, that the quota policy seed values
  are present, and that the owner/tenant columns and foreign keys exist.
  Re-running the migrator must report no changes.
- **R4 Application deploy, still legacy.** Deploy the new version with
  `OPENMAIC_AUTH_MODE` left at `legacy`. Smoke-test `/api/health`, the existing
  legacy (anonymous and access-code) flows, and that the admitted route set and
  the declared closed set behave as expected.
- **R5 Isolated OIDC validation.** Against a separate Keycloak realm, verify: a
  provisioned identity can sign in; an unprovisioned identity cannot; revoked,
  expired, disabled, and suspended-membership sessions are refused; `viewer` is
  read-only; a write with a mismatched `Origin` is refused; exactly the admitted
  routes answer while the declared closed set still answers `503`; and
  quota/rate-limit reservation and settlement behave.
- **R6 Limited OIDC rollout.** Switch `OPENMAIC_AUTH_MODE` to `oidc` as a
  controlled configuration change, not a code deploy. Watch authentication
  refusals, the `503` rate, database errors, and quota refusals, and widen the
  rollout only while those stay healthy.
- **R7 Close-out.** Keep OIDC mode once the metrics hold. ACCESS_CODE never
  becomes an OIDC bypass at any step.

### Rollback

- **L1 Configuration rollback (first choice).** Set `OPENMAIC_AUTH_MODE` back
  to `legacy`. OIDC session cookies stop being resolved and business routes
  return to legacy behavior; no code or schema rollback is needed. Consequence:
  data written under `user:<id>` during the OIDC window is not reachable under
  `legacy`, the same way anonymous `anon:` data is not reachable under OIDC.
  That loss of visibility is accepted and needs no export path.
- **L2 Application rollback.** Redeploy the previous application version. Every
  migration is a backward-compatible add-column/add-table/add-constraint change,
  so the schema is kept as-is; never delete a table or narrow a route-key CHECK
  to match an older application.
- **L3 Database restore.** Only for a data-corruption event, restore from the
  verified backup or PITR. First assess the loss of writes made after the
  migration, stop writers, and choose the restore point through the incident
  process.

Do not widen OIDC traffic while a migration version or checksum disagrees, a
backup restore is unverified, the PostgreSQL major version does not match the
rehearsal, Keycloak is unverified, error rates rise, or the rollback path has
not been rehearsed.

### Key rotation

Session signing accepts one key (`kid: v1`) with no dual-key verification
window, so rotating `OPENMAIC_SESSION_SIGNING_KEY` invalidates every existing
application session and requires a planned re-login window. Rotating
`OPENMAIC_OIDC_FLOW_KEY` invalidates in-flight login flows and needs a short
retry window; the OIDC client secret is switched in coordination with the IdP.
Generate both keys independently with a cryptographically secure generator and
inject them from the secret store; they must never enter the repository, logs,
or images. After any rotation, verify the callback, an existing session, a new
session, and logout, then revoke the old key.
