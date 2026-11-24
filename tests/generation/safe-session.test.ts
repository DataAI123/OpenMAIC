import { describe, expect, it } from 'vitest';
import type { GenerationSessionState } from '@/app/generation-preview/types';
import { sanitizeGenerationSession } from '@/lib/generation/safe-session';
import { isPDFProviderId } from '@/lib/pdf/constants';

describe('isPDFProviderId', () => {
  it('accepts registered provider ids and rejects arbitrary legacy session values', () => {
    expect(isPDFProviderId('alidocmind')).toBe(true);
    expect(isPDFProviderId('attacker-controlled')).toBe(false);
  });
});

describe('sanitizeGenerationSession', () => {
  it('removes legacy provider credentials before a session is persisted', () => {
    const legacySession = {
      sessionId: 'session-1',
      requirements: { requirement: 'A course' },
      pdfText: '',
      pdfProviderId: 'alicloud',
      pdfProviderConfig: {
        apiKey: 'api-key-secret',
        baseUrl: 'https://provider.example/path?token=url-secret',
        accessKeyId: 'access-key-id',
        accessKeySecret: 'access-key-secret',
      },
      documentSources: [
        {
          id: 'document-1',
          name: 'course.pdf',
          size: 1,
          order: 1,
          storageKey: 'storage-key',
          providerConfig: {
            apiKey: 'nested-api-key-secret',
            accessKeySecret: 'nested-access-key-secret',
          },
        },
      ],
      currentStep: 'generating' as const,
    } as unknown as GenerationSessionState;

    const sanitized = sanitizeGenerationSession(legacySession);
    const persisted = JSON.stringify(sanitized);

    expect(sanitized.pdfProviderId).toBe('alicloud');
    expect(sanitized.documentSources?.[0]).toMatchObject({
      id: 'document-1',
      storageKey: 'storage-key',
    });
    expect(persisted).not.toContain('pdfProviderConfig');
    expect(persisted).not.toContain('providerConfig');
    expect(persisted).not.toContain('api-key-secret');
    expect(persisted).not.toContain('url-secret');
    expect(persisted).not.toContain('access-key-id');
    expect(persisted).not.toContain('access-key-secret');
  });

  it('does not mutate the source session when scrubbing legacy document settings', () => {
    const legacySession = {
      sessionId: 'session-2',
      requirements: { requirement: 'A course' },
      pdfText: '',
      documentSources: [
        {
          id: 'document-2',
          name: 'course.pdf',
          size: 1,
          order: 1,
          storageKey: 'storage-key',
          providerConfig: { apiKey: 'legacy-secret' },
        },
      ],
      currentStep: 'generating' as const,
    } as unknown as GenerationSessionState;

    const sanitized = sanitizeGenerationSession(legacySession);

    expect(
      (legacySession.documentSources?.[0] as { providerConfig?: unknown }).providerConfig,
    ).toEqual({
      apiKey: 'legacy-secret',
    });
    expect(
      (sanitized.documentSources?.[0] as { providerConfig?: unknown }).providerConfig,
    ).toBeUndefined();
  });
});
