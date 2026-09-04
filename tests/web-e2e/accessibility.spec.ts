import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pageErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'Unexpected uncaught browser errors').toEqual([]);
  pageErrors.delete(page);
});

const acceptanceRoutes = [
  '/',
  '/auth',
  '/saved',
  '/feed',
  '/studio',
  '/profile',
  '/profile-edit',
  '/badges',
  '/creator-invite',
  '/creator-invitations',
  '/promotion-studio',
  '/place/acceptance-place',
  '/navigation/acceptance-place',
  '/order/acceptance-order',
  '/messages',
  '/messages/acceptance-conversation',
  '/business-onboarding',
  '/business-setup',
  '/business-profile',
  '/business-posts',
  '/business-team',
  '/business-marketplace',
  '/privacy',
  '/safety',
  '/legal',
  '/security',
  '/account-data',
  '/report',
  '/reset-password',
  '/moderation',
  '/marketplace-moderation',
];

for (const route of acceptanceRoutes) {
  test(`${route} has no serious rendered accessibility violations`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'networkidle' });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = result.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
}

test('business onboarding cold load focuses and names the loaded screen', async ({ page }) => {
  await page.goto('/business-onboarding', { waitUntil: 'networkidle' });
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle(`${await heading.textContent()} · Spottr`);
});

test('business onboarding contains a failed screen chunk', async ({ page }) => {
  await page.route('**/business-onboarding-screen-*.js', (route) => route.abort());
  await page.goto('/business-onboarding', { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { level: 1, name: 'Business verification is temporarily unavailable' })
  ).toBeVisible();
  await expect(page.getByText('Your information has not been submitted.')).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
});

test('route hydration focuses and names the active screen', async ({ page }) => {
  await page.goto('/privacy', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle(`${await heading.textContent()} · Spottr`);
});

test('back navigation restores focus to the control that opened the route', async ({ page }) => {
  await page.goto('/profile', { waitUntil: 'networkidle' });
  const privacyControl = page.getByRole('button', { name: /location privacy/i });
  await privacyControl.focus();
  await privacyControl.click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

  await page.goBack({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/profile$/);
  await expect(privacyControl).toBeFocused();
});


test('unconfigured discovery shell is explicit and keeps keyboard traversal bounded', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByText(/private preview is not connected to the verified listing database/i).first()).toBeVisible();
  const sequentialFocusTargetCount = await page
    .locator('a[href], button, input, select, textarea, [tabindex]')
    .evaluateAll((elements) => elements.filter((element) => {
      if (!(element instanceof HTMLElement) || element.tabIndex < 0) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
        style.display !== 'none';
    }).length);
  expect(sequentialFocusTargetCount).toBeLessThan(120);
  await expect(page.locator('.maplibregl-marker[tabindex="0"]')).toHaveCount(0);

  const visited = new Set<string>();
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    visited.add(await page.evaluate(() => {
      const active = document.activeElement;
      return `${active?.tagName ?? ''}:${active?.getAttribute('aria-label') ?? active?.textContent ?? ''}`;
    }));
  }
  expect(visited.size).toBeGreaterThan(4);
  expect([...visited].some((label) => /maplibregl-marker/i.test(label))).toBe(false);
});

test('mobile discovery has no horizontal overflow or undersized primary controls', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile viewport assertion');
  await page.goto('/', { waitUntil: 'networkidle' });
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

  const undersized = await page.locator('button, [role="button"], input').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (!visible || (rect.width >= 24 && rect.height >= 24)) return [];
      return [{
        label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
        width: rect.width,
        height: rect.height,
      }];
    })
  );
  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
});
