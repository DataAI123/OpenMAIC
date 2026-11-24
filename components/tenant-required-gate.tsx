'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { recoverClientAuthFailure } from '@/lib/auth/client-login';

type Tenant = {
  tenantId: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'active' | 'suspended';
};

type GateState = 'checking' | 'hidden' | 'loading-tenants' | 'ready' | 'unavailable';

const ROLE_LABEL_KEYS: Record<Tenant['role'], string> = {
  owner: 'settings.tenantRoleOwner',
  admin: 'settings.tenantRoleAdmin',
  member: 'settings.tenantRoleMember',
  viewer: 'settings.tenantRoleViewer',
};

function isTenant(value: unknown): value is Tenant {
  if (!value || typeof value !== 'object') return false;
  const tenant = value as Partial<Tenant>;
  return (
    typeof tenant.tenantId === 'string' &&
    typeof tenant.name === 'string' &&
    (tenant.role === 'owner' ||
      tenant.role === 'admin' ||
      tenant.role === 'member' ||
      tenant.role === 'viewer') &&
    (tenant.status === 'active' || tenant.status === 'suspended')
  );
}

export function TenantRequiredGate() {
  const { t } = useI18n();
  const [state, setState] = useState<GateState>('checking');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(false);
    setState('checking');
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
      const session = (await sessionResponse.json()) as { status?: unknown };
      if (session.status !== 'tenant-required') {
        setState('hidden');
        return;
      }

      setState('loading-tenants');
      const tenantsResponse = await fetch('/api/tenant', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!tenantsResponse.ok) {
        if (await recoverClientAuthFailure(tenantsResponse)) return;
        throw new Error('tenants-unavailable');
      }
      const body = (await tenantsResponse.json()) as { tenants?: unknown };
      if (!Array.isArray(body.tenants) || !body.tenants.every(isTenant)) {
        throw new Error('invalid-tenants-response');
      }
      setTenants(body.tenants);
      setState('ready');
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(true);
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const choose = async (tenant: Tenant) => {
    setBusyTenantId(tenant.tenantId);
    setError(false);
    try {
      const response = await fetch('/api/tenant/active', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.tenantId }),
      });
      if (!response.ok) {
        if (await recoverClientAuthFailure(response)) return;
        throw new Error('switch-failed');
      }
      window.location.reload();
    } catch {
      setError(true);
      setBusyTenantId(null);
      // Refresh membership/status so a revoked or suspended choice is explained.
      await load();
      setError(true);
    }
  };

  const open = state === 'loading-tenants' || state === 'ready' || state === 'unavailable';
  if (!open) return null;

  return (
    <Dialog open modal>
      <DialogContent
        showCloseButton={false}
        aria-busy={state === 'loading-tenants' || busyTenantId !== null}
        className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain"
      >
        <DialogHeader>
          <DialogTitle>{t('settings.tenantSelectTitle')}</DialogTitle>
          <DialogDescription>{t('settings.tenantSelectDescription')}</DialogDescription>
        </DialogHeader>
        {state === 'loading-tenants' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('settings.tenantOverviewLoading')}
          </p>
        ) : state === 'unavailable' ? (
          <div role="alert" className="space-y-3">
            <p>{t('settings.tenantOverviewUnavailable')}</p>
            <Button onClick={() => void load()}>{t('common.retry')}</Button>
          </div>
        ) : tenants.length === 0 ? (
          <div role="status" className="text-muted-foreground">
            {t('settings.tenantSelectEmpty')}
          </div>
        ) : (
          <div className="grid gap-2">
            {tenants.map((tenant) => {
              const active = tenant.status === 'active';
              return (
                <div
                  key={tenant.tenantId}
                  className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{tenant.name}</div>
                    <div className="text-muted-foreground text-xs">
                      {active
                        ? t(ROLE_LABEL_KEYS[tenant.role])
                        : t('settings.tenantStatusSuspended')}
                    </div>
                  </div>
                  <Button
                    disabled={!active || busyTenantId !== null}
                    aria-busy={busyTenantId === tenant.tenantId}
                    aria-label={t('settings.tenantSelectContinueFor', { tenant: tenant.name })}
                    onClick={() => void choose(tenant)}
                  >
                    {busyTenantId === tenant.tenantId
                      ? t('common.loading')
                      : t('settings.tenantSelectContinue')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {error && state === 'ready' ? (
          <p role="alert" className="text-destructive text-sm">
            {t('settings.tenantSelectChanged')}
          </p>
        ) : null}
        {busyTenantId !== null ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('settings.tenantSelectApplying')}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
