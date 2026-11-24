import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { SessionDocumentSource } from '@/lib/types/generation';

/** Remove credentials from legacy generation sessions before they reach memory or storage. */
export function sanitizeGenerationSession(session: GenerationSessionState): GenerationSessionState {
  const sanitized = { ...session };
  delete sanitized.pdfProviderConfig;

  if (sanitized.documentSources) {
    sanitized.documentSources = sanitized.documentSources.map((source) => {
      const safeSource = { ...source } as SessionDocumentSource & {
        providerConfig?: unknown;
      };
      delete safeSource.providerConfig;
      return safeSource;
    });
  }

  return sanitized;
}
