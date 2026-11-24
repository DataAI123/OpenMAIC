import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const pgMock = vi.hoisted(() => ({
  create: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      pgMock.create(options);
      return { query: pgMock.query, end: pgMock.end };
    }
  },
}));

async function getRoute() {
  const { GET } = await import('@/app/api/health/ready/route');
  return GET;
}

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    vi.resetModules();
    pgMock.create.mockReset();
    pgMock.query.mockReset().mockResolvedValue({ rows: [{ version: 23 }] });
    pgMock.end.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'legacy');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'false');
    vi.stubEnv('DATABASE_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('is ready in legacy mode when PostgreSQL is not configured', async () => {
    const GET = await getRoute();
    const response = await GET(new NextRequest('https://openmaic.example.com/api/health/ready'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(pgMock.create).not.toHaveBeenCalled();
  });

  it('fails closed when OIDC requires a database but its URL is missing', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    const GET = await getRoute();

    const response = await GET(new NextRequest('https://openmaic.example.com/api/health/ready'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, status: 'unavailable' });
    expect(pgMock.create).not.toHaveBeenCalled();
  });

  it('requires PostgreSQL when the durable agent runtime is enabled', async () => {
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const GET = await getRoute();

    const response = await GET(new NextRequest('https://openmaic.example.com/api/health/ready'));

    expect(response.status).toBe(503);
    expect(pgMock.create).not.toHaveBeenCalled();
  });

  it('checks the current minimum schema using a bounded, read-only pool', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    vi.stubEnv('DATABASE_URL', 'postgres://health-probe.invalid/openmaic');
    const GET = await getRoute();

    const request = () =>
      GET(
        new NextRequest('https://openmaic.example.com/api/health/ready', {
          headers: { 'x-request-id': 'readiness-check:1' },
        }),
      );
    const response = await request();
    const cachedResponse = await request();

    expect(response.status).toBe(200);
    expect(cachedResponse.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('readiness-check:1');
    expect(pgMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://health-probe.invalid/openmaic',
        max: 1,
        connectionTimeoutMillis: 1_000,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      }),
    );
    expect(pgMock.query).toHaveBeenCalledWith(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    expect(pgMock.query).toHaveBeenCalledOnce();
    expect(pgMock.end).toHaveBeenCalledOnce();
  });

  it('returns unavailable when the schema is behind the current minimum', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    vi.stubEnv('DATABASE_URL', 'postgres://health-probe.invalid/openmaic');
    pgMock.query.mockResolvedValue({ rows: [{ version: 22 }] });
    const GET = await getRoute();

    const response = await GET(new NextRequest('https://openmaic.example.com/api/health/ready'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, status: 'unavailable' });
    expect(pgMock.end).toHaveBeenCalledOnce();
  });

  it('does not expose driver errors and merges concurrent probes', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    vi.stubEnv('DATABASE_URL', 'postgres://health-probe.invalid/openmaic');
    let releaseQuery!: (result: { rows: Array<{ version: number }> }) => void;
    pgMock.query.mockImplementation(() => new Promise((resolve) => (releaseQuery = resolve)));
    const GET = await getRoute();

    const first = GET(new NextRequest('https://openmaic.example.com/api/health/ready'));
    const second = GET(new NextRequest('https://openmaic.example.com/api/health/ready'));
    await vi.waitFor(() => expect(pgMock.query).toHaveBeenCalledOnce());
    releaseQuery({ rows: [{ version: 23 }] });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(pgMock.create).toHaveBeenCalledOnce();
    expect(pgMock.end).toHaveBeenCalledOnce();
  });

  it('fails closed on database errors without returning their details', async () => {
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    vi.stubEnv('DATABASE_URL', 'postgres://health-probe.invalid/openmaic');
    pgMock.query.mockRejectedValue(new Error('password=private-secret connection failed'));
    const GET = await getRoute();

    const response = await GET(new NextRequest('https://openmaic.example.com/api/health/ready'));

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-secret');
    expect(pgMock.end).toHaveBeenCalledOnce();
  });
});
