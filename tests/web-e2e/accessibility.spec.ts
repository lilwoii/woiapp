import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const acceptanceRoutes = [
  '/',
  '/auth',
  '/saved',
  '/studio',
  '/profile',
  '/place/acceptance-place',
  '/order/acceptance-order',
  '/messages',
  '/messages/acceptance-conversation',
  '/business-onboarding',
  '/business-setup',
  '/business-profile',
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
  });
}

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


test('discovery keeps keyboard traversal and rendered annotations bounded', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const sequentialFocusTargets = page.locator(
    'a[href], button, input, select, textarea, [tabindex="0"]'
  );
  expect(await sequentialFocusTargets.count()).toBeLessThan(120);
  await expect(page.locator('.maplibregl-marker button[tabindex="0"]')).toHaveCount(0);

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
