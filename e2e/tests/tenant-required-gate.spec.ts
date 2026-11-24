import { expect, test } from '../fixtures/base';
import { HomePage } from '../pages/home.page';

test('tenant gate announces loading, traps keyboard focus, and releases after selection', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let sessionStatus = 'tenant-required';
  let releaseTenantList!: () => void;
  const tenantListReady = new Promise<void>((resolve) => {
    releaseTenantList = resolve;
  });
  let releaseSelection!: () => void;
  const selectionReady = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });

  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'oidc', status: sessionStatus }),
    }),
  );

  await page.route('**/api/tenant', async (route) => {
    expect(route.request().method()).toBe('GET');
    await tenantListReady;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        tenants: [
          { tenantId: 'org-a', name: 'Organization Alpha', role: 'owner', status: 'active' },
          {
            tenantId: 'org-paused',
            name: 'Organization Paused',
            role: 'member',
            status: 'suspended',
          },
        ],
      }),
    });
  });

  await page.route('**/api/tenant/active', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ tenantId: 'org-a' });
    await selectionReady;
    sessionStatus = 'authenticated';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Choose an organization' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('animation-name', 'none');
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS('animation-name', 'none');
  await expect(dialog.getByRole('status')).toContainText('Loading organization details…');
  releaseTenantList();

  const activeChoice = dialog.getByRole('button', { name: 'Continue to Organization Alpha' });
  const suspendedChoice = dialog.getByRole('button', { name: 'Continue to Organization Paused' });
  await expect(activeChoice).toBeEnabled();
  await expect(suspendedChoice).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab');
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  await activeChoice.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status')).toContainText('Applying organization…');
  releaseSelection();
  await expect(dialog).toBeHidden();
  await expect(new HomePage(page).logo).toBeVisible();
});
