import { expect, test } from '@playwright/test';

const owner = { username: 'enterprise-owner', password: 'Owner-E2E-only-2026', role: 'owner' };
const viewer = { username: 'enterprise-viewer', password: 'Viewer-E2E-only-2026', role: 'viewer' };
const selector = {
  username: 'enterprise-selector',
  password: 'Selector-E2E-only-2026',
};

async function signIn(
  page: import('@playwright/test').Page,
  user: { username: string; password: string },
): Promise<string> {
  await page.goto('/api/auth/login?returnTo=%2F');
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL('https://localhost:3002/');
  const cookie = (await page.context().cookies()).find((item) => item.name === 'openmaic_session');
  expect(cookie, 'OIDC callback should issue the application session cookie').toBeDefined();
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  if (!cookie) throw new Error('OIDC application session cookie was not issued');
  return cookie.value;
}

for (const user of [owner, viewer]) {
  test(`${user.role} completes HTTPS OIDC login and receives only its tenant permissions`, async ({
    page,
  }) => {
    const sessionCookie = await signIn(page, user);

    const sessionResponse = await page.request.get('/api/auth/session');
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session).toMatchObject({
      mode: 'oidc',
      status: 'authenticated',
      tenantId: 'default',
      role: user.role,
    });

    const tenantResponse = await page.request.get('/api/tenant');
    expect(tenantResponse.status()).toBe(200);
    expect(await tenantResponse.json()).toMatchObject({
      success: true,
      tenants: [expect.objectContaining({ tenantId: 'default', role: user.role })],
    });

    const membersResponse = await page.request.get('/api/tenant/members');
    if (user.role === 'owner') {
      expect(membersResponse.status()).toBe(200);
      expect(await membersResponse.json()).toMatchObject({
        success: true,
        members: expect.arrayContaining([expect.objectContaining({ role: 'viewer' })]),
      });
    } else {
      expect(membersResponse.status()).toBe(403);
      expect(await membersResponse.json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    }

    const rejectedLogout = await page.request.post('/api/auth/logout', {
      headers: { origin: 'https://attacker.example' },
    });
    expect(rejectedLogout.status()).toBe(403);
    const sessionAfterRejectedLogout = await page.request.get('/api/auth/session');
    expect(sessionAfterRejectedLogout.status()).toBe(200);
    expect(await sessionAfterRejectedLogout.json()).toMatchObject({
      mode: 'oidc',
      status: 'authenticated',
      role: user.role,
    });

    const logout = await page.request.post('/api/auth/logout', {
      headers: { origin: 'https://localhost:3002' },
    });
    expect(logout.status()).toBe(204);
    expect((await page.request.get('/api/auth/session')).status()).toBe(200);
    expect(await (await page.request.get('/api/auth/session')).json()).toMatchObject({
      mode: 'oidc',
      status: 'guest',
    });
    const revokedSessionResponse = await page.request.get('/api/auth/session', {
      headers: { cookie: `openmaic_session=${sessionCookie}` },
    });
    expect(revokedSessionResponse.status()).toBe(200);
    expect(await revokedSessionResponse.json()).toMatchObject({
      mode: 'oidc',
      status: 'guest',
    });
  });
}

test('a user with multiple tenant memberships must choose before using a tenant', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
  await signIn(page, selector);

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('选择组织');
  await expect(dialog).toContainText('Default organization');
  await expect(dialog).toContainText('Secondary organization');

  const unresolvedSession = await page.request.get('/api/auth/session');
  expect(unresolvedSession.status()).toBe(200);
  expect(await unresolvedSession.json()).toMatchObject({
    mode: 'oidc',
    status: 'tenant-required',
  });

  await dialog.getByRole('button', { name: '进入 Secondary organization' }).click();
  await expect(dialog).toHaveCount(0);

  const selectedSession = await page.request.get('/api/auth/session');
  expect(selectedSession.status()).toBe(200);
  expect(await selectedSession.json()).toMatchObject({
    mode: 'oidc',
    status: 'authenticated',
    tenantId: 'secondary',
    role: 'viewer',
  });
  const tenantResponse = await page.request.get('/api/tenant');
  expect(tenantResponse.status()).toBe(200);
  expect(await tenantResponse.json()).toMatchObject({
    success: true,
    tenants: expect.arrayContaining([
      expect.objectContaining({ tenantId: 'default', role: 'owner' }),
      expect.objectContaining({ tenantId: 'secondary', role: 'viewer' }),
    ]),
  });
});
