import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  fixtureAppOrigin,
  installSpottrFixture,
  signInThroughUi,
} from './supabase-fixture';

const unexpectedRequests = new WeakMap<object, string[]>();
const pageErrors = new WeakMap<object, string[]>();
const fixtureObservations = new WeakMap<
  object,
  Awaited<ReturnType<typeof installSpottrFixture>>
>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await installSpottrFixture(page);
  unexpectedRequests.set(page, fixture.unexpected);
  fixtureObservations.set(page, fixture);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'Unexpected uncaught browser errors').toEqual([]);
  expect(unexpectedRequests.get(page) ?? [], 'Unexpected Supabase fixture requests').toEqual([]);
  pageErrors.delete(page);
  unexpectedRequests.delete(page);
  fixtureObservations.delete(page);
});

async function expectNoSeriousAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test('populated discovery renders real results and bounds a 1,200-feature map response', async ({ page }) => {
  const fixture = fixtureObservations.get(page);
  expect(fixture).toBeDefined();
  await page.goto(`${fixtureAppOrigin}/`, { waitUntil: 'networkidle' });
  await page.getByLabel('City or ZIP code').fill('Los Angeles, CA');
  await page.getByRole('button', { name: 'Set area' }).click();

  await expect(page.getByRole('link', { name: 'View Maya Taco Truck' }).first()).toBeVisible();
  await expect(page.getByText('700 S Santa Fe Ave').first()).toBeVisible();
  await expect(page.getByText(/Food truck · Mexican · Street food/u).first()).toBeVisible();
  await expect(page.getByText('4.9').first()).toBeVisible();
  await expect(page.getByLabel('Interactive map of nearby food')).toBeVisible();
  await expect.poll(() => fixture?.mapRequests.length ?? 0).toBe(1);
  expect(fixture?.mapRequests[0]).toMatchObject({
    max_features: 1_200,
    requested_kinds: ['food_truck', 'restaurant', 'pop_up', 'cafe_bakery'],
  });
  await expect(page.locator('.maplibregl-marker[aria-label="1194 food places in this area. Zoom in to explore."]')).toHaveCount(1);
  expect(await page.locator('.maplibregl-marker').count()).toBeLessThan(80);
  for (const category of ['food_truck', 'restaurant', 'pop_up', 'cafe_bakery']) {
    await expect(page.locator(`button[data-category="${category}"]`).first()).toBeVisible();
  }
  await expect(page.locator('[data-category="home_kitchen"]')).toHaveCount(0);
  const perspective = page.getByRole('button', { name: 'Use 3D map perspective' });
  await perspective.click();
  await expect(page.getByRole('button', { name: 'Use flat map view' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.maplibregl-marker[tabindex="0"]')).toHaveCount(0);
  await expect.poll(() => fixture?.realtimeConnections ?? 0).toBeGreaterThan(0);
  await expectNoSeriousAxeViolations(page);
});

test('customer sign-in hydrates a verified profile and saved-place state', async ({ page }) => {
  await signInThroughUi(page, 'customer');
  await page.goto(`${fixtureAppOrigin}/profile`, { waitUntil: 'networkidle' });

  await expect(page.getByText('Jordan Lee')).toBeVisible();
  await expect(page.getByText('@jordan.finds')).toBeVisible();
  await expect(page.getByText('Customer account')).toBeVisible();
  await expect(page.getByText('Verified session')).toBeVisible();
  await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

test('password sign-in hydrates a synthetic AAL2 owner session and opens Studio', async ({ page }) => {
  await signInThroughUi(page, 'business');
  await page.goto(`${fixtureAppOrigin}/studio`, { waitUntil: 'networkidle' });

  await expect(page.getByText('Owner access')).toBeVisible();
  await expect(page.getByText('Maya Taco Truck').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /run today.s service in a few taps/i })).toBeVisible();
  await expect(page.getByText('Birria taco')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish update' })).toBeVisible();
  await expect(page.getByText('Protect this business workspace.')).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
});

test('authenticated chat lists a private conversation with unread state', async ({ page }) => {
  await signInThroughUi(page, 'customer');
  await page.goto(`${fixtureAppOrigin}/messages`, { waitUntil: 'networkidle' });

  await expect(page.getByRole('button', { name: /open conversation with avery chen for maya taco truck/i })).toBeVisible();
  await expect(page.getByText('@taco.scout · Maya Taco Truck')).toBeVisible();
  await expect(page.getByText('See you at the Arts District stop.')).toBeVisible();
  await expect(page.getByText('2', { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

test('authenticated foreground navigation draws a provider route and remains user-controlled', async ({ context, page }) => {
  const fixture = fixtureObservations.get(page);
  expect(fixture).toBeDefined();
  await context.grantPermissions(['geolocation'], { origin: fixtureAppOrigin });
  await context.setGeolocation({ latitude: 34.0522, longitude: -118.2437 });
  await signInThroughUi(page, 'customer');
  await page.goto(`${fixtureAppOrigin}/place/${fixture?.ids.business}`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Navigate in Spottr' }).click();
  await expect(page).toHaveURL(`${fixtureAppOrigin}/navigation/${fixture?.ids.business}`);
  await expect(page.getByText(/sends your selected starting point and this public destination to Mapbox/i)).toBeVisible();
  expect(fixture?.routeRequests).toHaveLength(0);

  await page.getByRole('radio', { name: 'Walk' }).click();
  await expect.poll(() => fixture?.routeRequests.length ?? 0).toBe(1);
  expect(fixture?.routeRequests[0]).toEqual({
    origin: { latitude: 34.0522, longitude: -118.2437 },
    destination: { latitude: 34.0355, longitude: -118.2324 },
    mode: 'walk',
  });
  await expect(page.getByText('Head southeast toward the Arts District')).toBeVisible();
  await expect(page.getByText('26 min · 1.3 mi')).toBeVisible();
  await expect(page.locator('.maplibregl-marker[aria-label="Your live walk position"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Hide route' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide route' }).click();
  await expect(page.getByRole('button', { name: 'Show route' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop tracking' }).click();
  await expect(page.getByText('Live tracking stopped.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Walk' })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});
