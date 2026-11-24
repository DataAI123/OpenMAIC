'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { recoverClientAuthFailure, refreshTenantSelection } from '@/lib/auth/client-login';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Tenant = {
  tenantId: string;
  name: string;
  role: Role;
  status: 'active' | 'suspended';
};
type Member = {
  userId: string;
  displayName: string | null;
  role: Role;
  status: 'active' | 'suspended';
  createdAt: string;
};
type AuditEntry = {
  actorUserId: string | null;
  subjectUserId: string;
  action: 'grant' | 'change' | 'revoke';
  previousRole: Role | null;
  newRole: Role | null;
  reason: string | null;
  createdAt: string;
};
type ViewState = 'loading' | 'hidden' | 'ready' | 'unavailable';

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };
const ROLE_LABEL_KEYS: Record<Role, string> = {
  owner: 'settings.tenantRoleOwner',
  admin: 'settings.tenantRoleAdmin',
  member: 'settings.tenantRoleMember',
  viewer: 'settings.tenantRoleViewer',
};
const STATUS_LABEL_KEYS = {
  active: 'settings.tenantStatusActive',
  suspended: 'settings.tenantStatusSuspended',
} as const;
const AUDIT_ACTION_KEYS: Record<AuditEntry['action'], string> = {
  grant: 'settings.tenantAuditGrant',
  change: 'settings.tenantAuditChange',
  revoke: 'settings.tenantAuditRevoke',
};

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.includes(value as Role);
}

function isTenant(value: unknown): value is Tenant {
  if (!value || typeof value !== 'object') return false;
  const tenant = value as Partial<Tenant>;
  return (
    typeof tenant.tenantId === 'string' &&
    typeof tenant.name === 'string' &&
    isRole(tenant.role) &&
    (tenant.status === 'active' || tenant.status === 'suspended')
  );
}

function isMember(value: unknown): value is Member {
  if (!value || typeof value !== 'object') return false;
  const member = value as Partial<Member>;
  return (
    typeof member.userId === 'string' &&
    (member.displayName === null || typeof member.displayName === 'string') &&
    isRole(member.role) &&
    (member.status === 'active' || member.status === 'suspended') &&
    typeof member.createdAt === 'string'
  );
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<AuditEntry>;
  return (
    typeof entry.subjectUserId === 'string' &&
    (entry.actorUserId === null || typeof entry.actorUserId === 'string') &&
    (entry.action === 'grant' || entry.action === 'change' || entry.action === 'revoke') &&
    (entry.previousRole === null || isRole(entry.previousRole)) &&
    (entry.newRole === null || isRole(entry.newRole)) &&
    (entry.reason === null || typeof entry.reason === 'string') &&
    typeof entry.createdAt === 'string'
  );
}

export function TenantOverview() {
  const { locale, t } = useI18n();
  const [state, setState] = useState<ViewState>('loading');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tenantNameDraft, setTenantNameDraft] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role>>({});
  const [newMemberId, setNewMemberId] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<Role>('member');
  const [adminActionBusy, setAdminActionBusy] = useState<string | null>(null);
  const [adminActionError, setAdminActionError] = useState<'failed' | 'conflict' | null>(null);
  const [adminDataUnavailable, setAdminDataUnavailable] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading');
    setAdminDataUnavailable(false);
    try {
      const sessionResponse = await fetch('/api/auth/session', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!sessionResponse.ok) {
        if (await recoverClientAuthFailure(sessionResponse)) return;
        throw new Error('session-unavailable');
      }
      const session = (await sessionResponse.json()) as {
        mode?: unknown;
        status?: unknown;
        tenantId?: unknown;
        userId?: unknown;
        role?: unknown;
      };
      if (session.mode !== 'oidc' || session.status !== 'authenticated') {
        setState('hidden');
        return;
      }
      if (
        typeof session.tenantId !== 'string' ||
        typeof session.userId !== 'string' ||
        !isRole(session.role)
      ) {
        throw new Error('invalid-session');
      }
      setActorUserId(session.userId);

      const tenantsResponse = await fetch('/api/tenant', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!tenantsResponse.ok) {
        if (await recoverClientAuthFailure(tenantsResponse)) return;
        throw new Error('tenant-list-unavailable');
      }
      const tenantsBody = (await tenantsResponse.json()) as { tenants?: unknown };
      if (!Array.isArray(tenantsBody.tenants) || !tenantsBody.tenants.every(isTenant)) {
        throw new Error('invalid-tenant-list');
      }
      const activeTenant = tenantsBody.tenants.find((item) => item.tenantId === session.tenantId);
      if (!activeTenant) throw new Error('active-tenant-unavailable');
      setTenant(activeTenant);
      setTenantNameDraft(activeTenant.name);

      if (session.role === 'owner' || session.role === 'admin') {
        const [membersResponse, auditResponse] = await Promise.all([
          fetch('/api/tenant/members', { cache: 'no-store', credentials: 'same-origin', signal }),
          fetch('/api/tenant/audit?limit=50', {
            cache: 'no-store',
            credentials: 'same-origin',
            signal,
          }),
        ]);
        if (!membersResponse.ok || !auditResponse.ok) {
          if (!membersResponse.ok && (await recoverClientAuthFailure(membersResponse))) return;
          if (!auditResponse.ok && (await recoverClientAuthFailure(auditResponse))) return;
          setAdminDataUnavailable(true);
        } else {
          const [membersBody, auditBody] = await Promise.all([
            membersResponse.json(),
            auditResponse.json(),
          ]);
          if (
            !Array.isArray(membersBody.members) ||
            !membersBody.members.every(isMember) ||
            !Array.isArray(auditBody.entries) ||
            !auditBody.entries.every(isAuditEntry)
          ) {
            setAdminDataUnavailable(true);
          } else {
            setMembers(membersBody.members);
            setRoleDrafts(
              Object.fromEntries(
                membersBody.members.map((member: Member) => [member.userId, member.role]),
              ),
            );
            setAudit(auditBody.entries);
          }
        }
      }
      setState('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState('unavailable');
    }
  }, []);

  const canManageMember = (member: Member) =>
    Boolean(
      tenant &&
      actorUserId !== member.userId &&
      (tenant.role === 'owner' || ROLE_RANK[tenant.role] > ROLE_RANK[member.role]),
    );

  const memberName = (member: Member) =>
    member.displayName ? `${member.displayName} (${member.userId})` : member.userId;

  const memberRequest = async (
    memberId: string,
    method: 'PUT' | 'PATCH' | 'DELETE',
    body?: Record<string, unknown>,
  ) => {
    setAdminActionBusy(memberId);
    setAdminActionError(null);
    try {
      const response = await fetch(`/api/tenant/members/${encodeURIComponent(memberId)}`, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        if (await recoverClientAuthFailure(response)) return;
        setAdminActionError(response.status === 409 ? 'conflict' : 'failed');
        return;
      }
      if (method === 'PUT') setNewMemberId('');
      await load();
    } catch {
      setAdminActionError('failed');
    } finally {
      setAdminActionBusy(null);
    }
  };

  const assignMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const userId = newMemberId.trim();
    if (!userId || !tenant || !actorUserId) return;
    if (tenant.role === 'admin' && ROLE_RANK[newMemberRole] >= ROLE_RANK.admin) return;
    if (
      !window.confirm(
        t('settings.tenantAdminConfirmMemberAction', {
          action: t('settings.tenantAdminAssign'),
          member: userId,
        }),
      )
    ) {
      return;
    }
    await memberRequest(userId, 'PUT', { role: newMemberRole });
  };

  const updateTenantName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = tenantNameDraft.trim();
    if (!tenant || tenant.role !== 'owner' || !name || name.length > 200) return;
    if (
      !window.confirm(
        t('settings.tenantAdminConfirmRename', {
          name: `${name} (${tenant.tenantId})`,
        }),
      )
    ) {
      return;
    }
    setAdminActionBusy('tenant');
    setAdminActionError(null);
    try {
      const response = await fetch(`/api/tenant/${encodeURIComponent(tenant.tenantId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        if (await recoverClientAuthFailure(response)) return;
        setAdminActionError(response.status === 409 ? 'conflict' : 'failed');
        return;
      }
      await load();
    } catch {
      setAdminActionError('failed');
    } finally {
      setAdminActionBusy(null);
    }
  };

  const leaveTenant = async () => {
    if (!tenant) return;
    if (
      !window.confirm(
        t('settings.tenantAdminConfirmLeave', {
          tenant: `${tenant.name} (${tenant.tenantId})`,
        }),
      )
    ) {
      return;
    }
    setAdminActionBusy('tenant');
    setAdminActionError(null);
    try {
      const response = await fetch('/api/tenant/leave', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.tenantId }),
      });
      if (!response.ok) {
        if (await recoverClientAuthFailure(response)) return;
        setAdminActionError(response.status === 409 ? 'conflict' : 'failed');
        setAdminActionBusy(null);
        return;
      }
      refreshTenantSelection();
    } catch {
      setAdminActionError('failed');
      setAdminActionBusy(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state === 'hidden') return null;

  return (
    <section
      className="rounded-xl border p-4 space-y-4"
      aria-labelledby="tenant-overview-title"
      aria-busy={adminActionBusy !== null}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="tenant-overview-title" className="text-sm font-semibold">
          {t('settings.tenantOverviewTitle')}
        </h3>
        {state === 'unavailable' && (
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        )}
      </div>
      {state === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.tenantOverviewLoading')}
        </p>
      ) : state === 'unavailable' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('settings.tenantOverviewUnavailable')}
        </p>
      ) : tenant ? (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('settings.tenantOverviewTenant')}
              </dt>
              <dd className="font-medium">{tenant.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('settings.tenantOverviewYourRole')}
              </dt>
              <dd className="font-medium">{t(ROLE_LABEL_KEYS[tenant.role])}</dd>
            </div>
          </dl>
          {adminActionError && (
            <p role="alert" className="text-sm text-destructive">
              {adminActionError === 'conflict'
                ? t('settings.tenantAdminConflict')
                : t('settings.tenantAdminUpdateFailed')}
            </p>
          )}
          {adminActionBusy !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            {tenant.role === 'owner' && (
              <form
                className="flex min-w-48 flex-1 items-end gap-2"
                onSubmit={(event) => void updateTenantName(event)}
              >
                <label className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t('settings.tenantOverviewTenant')}
                  <input
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                    value={tenantNameDraft}
                    onChange={(event) => setTenantNameDraft(event.target.value)}
                    maxLength={200}
                    required
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={tenantNameDraft.trim() === tenant.name || adminActionBusy !== null}
                >
                  {t('settings.tenantAdminRename')}
                </Button>
              </form>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={adminActionBusy !== null}
              onClick={() => void leaveTenant()}
            >
              {t('settings.tenantAdminLeave')}
            </Button>
          </div>
          {tenant.status === 'suspended' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(STATUS_LABEL_KEYS.suspended)}
            </p>
          ) : tenant.role === 'owner' || tenant.role === 'admin' ? (
            <>
              <form
                className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
                onSubmit={(event) => void assignMember(event)}
              >
                <label className="min-w-48 flex-1 text-xs text-muted-foreground">
                  {t('settings.tenantAdminUserId')}
                  <input
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                    value={newMemberId}
                    onChange={(event) => setNewMemberId(event.target.value)}
                    maxLength={256}
                    required
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  {t('settings.tenantAdminMemberRole')}
                  <select
                    className="mt-1 h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                    value={newMemberRole}
                    onChange={(event) => setNewMemberRole(event.target.value as Role)}
                  >
                    {ROLES.filter(
                      (role) => tenant.role === 'owner' || ROLE_RANK[role] < ROLE_RANK.admin,
                    ).map((role) => (
                      <option key={role} value={role}>
                        {t(ROLE_LABEL_KEYS[role])}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!newMemberId.trim() || adminActionBusy !== null}
                >
                  {t('settings.tenantAdminAssign')}
                </Button>
              </form>
              {adminDataUnavailable ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p role="alert" className="text-sm text-destructive">
                    {t('settings.tenantOverviewAdminDataUnavailable')}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void load()}>
                    {t('common.retry')}
                  </Button>
                </div>
              ) : (
                <div className="grid gap-4">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('settings.tenantOverviewMembers')}
                    </h4>
                    {members.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('settings.tenantOverviewNoMembers')}
                      </p>
                    ) : (
                      <ul className="divide-y rounded-lg border">
                        {members.map((member) => (
                          <li
                            key={member.userId}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {member.displayName || member.userId}
                              </div>
                              {member.displayName && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {member.userId}
                                </div>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <span className="text-xs text-muted-foreground">
                                {t(STATUS_LABEL_KEYS[member.status])}
                              </span>
                              {canManageMember(member) ? (
                                <>
                                  <select
                                    className="h-8 rounded-md border bg-background px-2 text-xs"
                                    aria-label={`${t('settings.tenantAdminMemberRole')}: ${memberName(member)}`}
                                    value={roleDrafts[member.userId] ?? member.role}
                                    onChange={(event) =>
                                      setRoleDrafts((current) => ({
                                        ...current,
                                        [member.userId]: event.target.value as Role,
                                      }))
                                    }
                                  >
                                    {ROLES.filter(
                                      (role) =>
                                        tenant.role === 'owner' ||
                                        ROLE_RANK[role] < ROLE_RANK.admin,
                                    ).map((role) => (
                                      <option key={role} value={role}>
                                        {t(ROLE_LABEL_KEYS[role])}
                                      </option>
                                    ))}
                                  </select>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={
                                      adminActionBusy !== null ||
                                      (roleDrafts[member.userId] ?? member.role) === member.role
                                    }
                                    onClick={() => {
                                      const role = roleDrafts[member.userId] ?? member.role;
                                      if (
                                        window.confirm(
                                          t('settings.tenantAdminConfirmRole', {
                                            member: memberName(member),
                                            role: t(ROLE_LABEL_KEYS[role]),
                                          }),
                                        )
                                      ) {
                                        void memberRequest(member.userId, 'PUT', { role });
                                      }
                                    }}
                                  >
                                    {t('settings.tenantAdminSaveRole')}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={adminActionBusy !== null}
                                    onClick={() => {
                                      const nextStatus =
                                        member.status === 'active' ? 'suspended' : 'active';
                                      const label =
                                        nextStatus === 'suspended'
                                          ? t('settings.tenantAdminSuspend')
                                          : t('settings.tenantAdminResume');
                                      if (
                                        window.confirm(
                                          t('settings.tenantAdminConfirmMemberAction', {
                                            action: label,
                                            member: memberName(member),
                                          }),
                                        )
                                      ) {
                                        void memberRequest(member.userId, 'PATCH', {
                                          status: nextStatus,
                                        });
                                      }
                                    }}
                                  >
                                    {member.status === 'active'
                                      ? t('settings.tenantAdminSuspend')
                                      : t('settings.tenantAdminResume')}
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    disabled={adminActionBusy !== null}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          t('settings.tenantAdminConfirmMemberAction', {
                                            action: t('settings.tenantAdminRemove'),
                                            member: memberName(member),
                                          }),
                                        )
                                      ) {
                                        void memberRequest(member.userId, 'DELETE');
                                      }
                                    }}
                                  >
                                    {t('settings.tenantAdminRemove')}
                                  </Button>
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {t(ROLE_LABEL_KEYS[member.role])}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('settings.tenantOverviewAudit')}
                    </h4>
                    {audit.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('settings.tenantOverviewNoAudit')}
                      </p>
                    ) : (
                      <ul className="divide-y rounded-lg border">
                        {audit.map((entry, index) => (
                          <li
                            key={`${entry.createdAt}-${entry.subjectUserId}-${index}`}
                            className="space-y-1 px-3 py-2 text-sm"
                          >
                            <div className="font-medium">
                              {t(AUDIT_ACTION_KEYS[entry.action])}: {entry.subjectUserId}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t('settings.tenantAdminMemberRole')}:{' '}
                              {entry.previousRole ? t(ROLE_LABEL_KEYS[entry.previousRole]) : '—'} →{' '}
                              {entry.newRole ? t(ROLE_LABEL_KEYS[entry.newRole]) : '—'}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t('settings.tenantOverviewBy')} {entry.actorUserId || '—'} ·{' '}
                              <time dateTime={entry.createdAt}>
                                {new Date(entry.createdAt).toLocaleString(locale)}
                              </time>
                            </div>
                            {entry.reason && (
                              <div className="break-words text-xs text-muted-foreground">
                                {t('settings.tenantOverviewReason')}: {entry.reason}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('settings.tenantOverviewNoAdminAccess')}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
