import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/health/live/route';

describe('GET /api/health/live', () => {
  it('returns a minimal process liveness response', async () => {
    const response = GET(
      new NextRequest('https://openmaic.example.com/api/health/live', {
        headers: { 'x-request-id': 'health-live:check' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('health-live:check');
    expect(await response.json()).toEqual({ success: true, status: 'ok' });
  });
});
