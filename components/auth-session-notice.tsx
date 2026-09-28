'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  AUTH_RESULT_PARAM,
  readAuthResult,
  withoutAuthResult,
  type AuthResult,
} from '@/lib/auth/client-login';

const MESSAGE_KEYS: Record<AuthResult, string> = {
  denied: 'auth.denied',
  failed: 'auth.failed',
  unavailable: 'auth.unavailable',
};

/**
 * Shows the outcome of an OIDC round-trip and takes the result parameter back
 * out of the URL. Display only — it decides nothing about access; middleware
 * and the Node owner boundary already did.
 *
 * It reads `window.location` inside an effect rather than `useSearchParams`, so
 * mounting it in the root layout adds no Suspense boundary and no per-navigation
 * subscription.
 */
export function AuthSessionNotice() {
  const { t } = useI18n();

  useEffect(() => {
    const search = window.location.search;
    if (!new URLSearchParams(search).has(AUTH_RESULT_PARAM)) return;

    const result = readAuthResult(search);
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${withoutAuthResult(search)}${window.location.hash}`,
    );

    if (!result) return;
    const message = t(MESSAGE_KEYS[result]);
    if (result === 'denied') {
      toast.warning(message);
      return;
    }
    toast.error(message);
  }, [t]);

  return null;
}
